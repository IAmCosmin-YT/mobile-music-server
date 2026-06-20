const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function canonicalYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "music.youtube.com" && parsed.searchParams.has("v")) {
      return `https://www.youtube.com/watch?v=${parsed.searchParams.get("v")}`;
    }
    if (parsed.hostname === "youtu.be" && parsed.pathname.length > 1) {
      return `https://www.youtube.com/watch?v=${parsed.pathname.slice(1)}`;
    }
    return url;
  } catch {
    return url;
  }
}

function wrapSpawnError(error) {
  if (error && error.code === "ENOENT") {
    return new Error(
      "yt-dlp is not installed or is not on PATH. In Termux, run: python -m pip install -U \"yt-dlp[default]\""
    );
  }
  return error;
}

function tail(text, lines = 10) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

function makeExitError(stderr, code, label, target) {
  return new Error([
    `yt-dlp failed during ${label}.`,
    `Target: ${target}`,
    tail(stderr) || `yt-dlp exited with code ${code}`
  ].join("\n"));
}

function combineAttemptErrors(errors, options = {}) {
  const joined = errors.map((error) => error.message).join("\n");
  const hints = [];
  if (/HTTP Error 403|Forbidden/i.test(joined)) {
    hints.push(
      "YouTube returned HTTP 403 on all player client attempts. " +
      "Try: pip install -U yt-dlp (or: pip install -U yt-dlp-nightly for bleeding-edge fixes). " +
      "Also try: yt-dlp --rm-cache-dir. " +
      "If still failing, set up a PO-token provider (see yt-dlp wiki)."
    );
  }
  if (/\[pot:bgutil:http\].*Error reaching GET .*\/ping/i.test(joined)) {
    hints.push(
      "The bgutil PO-token plugin is installed but its token server is not reachable. " +
      "Start the bgutil provider server before the music server."
    );
  }
  if (options.cookies) {
    const exists = fs.existsSync(options.cookies);
    hints.push(`Cookie file: ${options.cookies} (${exists ? "found" : "NOT FOUND"})`);
  }
  if (!options.soundCloudFallback) {
    hints.push("SoundCloud fallback is disabled.");
  }

  return new Error([
    "All download attempts failed.",
    ...hints,
    "",
    ...errors.map((error, index) => `Attempt ${index + 1} (${error.label}): ${tail(error.message, 3)}`)
  ].join("\n"));
}

/**
 * Build base yt-dlp arguments from global options, merged with plan-level overrides.
 * Plan-level extractorArgs are MERGED with (not replaced by) global extractorArgs.
 */
function buildYtDlpBaseArgs(options = {}, plan = {}) {
  const args = [];
  if (options.jsRuntime && options.jsRuntime !== "none") {
    args.push("--js-runtimes", options.jsRuntime);
  }
  if (options.remoteComponents) {
    args.push("--remote-components", options.remoteComponents);
  }
  if (options.userAgent) {
    args.push("--user-agent", options.userAgent);
  }

  // Merge extractor args: plan-level args take priority, global args are appended
  const planArgs = plan.extractorArgs || "";
  const globalArgs = options.extractorArgs || "";
  const mergedArgs = [planArgs, globalArgs].filter(Boolean).join(";");
  if (mergedArgs) {
    args.push("--extractor-args", mergedArgs);
  }

  if (options.impersonate) {
    args.push("--impersonate", options.impersonate);
  }
  if (options.cookies && !plan.noCookies) {
    args.push("--cookies", options.cookies);
  }
  if (options.cookiesFromBrowser && !plan.noCookies) {
    args.push("--cookies-from-browser", options.cookiesFromBrowser);
  }
  if (options.useOauth2 && !plan.noCookies) {
    args.push("--username", "oauth2", "--password", "");
  }
  return args;
}

function isYouTubeTarget(value) {
  return /(^|:\/\/)(www\.youtube\.com|music\.youtube\.com|youtu\.be)\//i.test(String(value || ""));
}

/**
 * Build download plans. The key change: instead of varying the SEARCH QUERY
 * (official audio, topic, album track, etc.), we vary the PLAYER CLIENT
 * (mweb, web_safari, default, tv_embedded). The search query is resolved once.
 *
 * For a direct URL:  try the URL with each player client
 * For a query:       search once with ytsearch1, then try each player client
 */
function buildDownloadPlans(query, url, options = {}) {
  const plans = [];
  const trimmedUrl = String(url || "").trim();
  const trimmedQuery = String(query || "").trim();
  const useSoundCloudFallback = Boolean(options.soundCloudFallback);

  // Resolve the target(s) — URL takes priority, then query-based search
  const targets = [];

  if (trimmedUrl && isUrl(trimmedUrl)) {
    const canonical = isYouTubeTarget(trimmedUrl)
      ? canonicalYouTubeWatchUrl(trimmedUrl)
      : trimmedUrl;
    targets.push({ target: canonical, sourceStrategy: "direct-url" });
  }

  if (trimmedQuery && !isUrl(trimmedQuery)) {
    targets.push({
      target: `ytsearch1:${trimmedQuery}`,
      sourceStrategy: "search"
    });
  }

  // For each target, try different player client strategies
  // These address the actual 403 problem by using different YouTube API clients
  // Order based on latest yt-dlp community recommendations (2025/2026)
  const clientStrategies = [
    {
      // Reddit/community recommended combo — tries multiple clients in one call
      label: "web_embedded+web",
      extractorArgs: "youtube:player_client=web_embedded,web",
      noCookies: false
    },
    {
      label: "mweb",
      extractorArgs: "youtube:player_client=mweb",
      noCookies: false
    },
    {
      // HLS streams often bypass 403 blocks
      label: "web_safari",
      extractorArgs: "youtube:player_client=web_safari",
      format: "ba[protocol*=m3u8]/bestaudio/best",
      noCookies: false
    },
    {
      // Let yt-dlp pick its own default (it updates its own defaults with releases)
      label: "default",
      extractorArgs: null,
      noCookies: false
    },
    {
      label: "tv_embedded",
      extractorArgs: "youtube:player_client=tv_embedded",
      noCookies: false
    },
    {
      // Cookies themselves can sometimes cause 403s — try without
      label: "mweb-no-cookies",
      extractorArgs: "youtube:player_client=mweb",
      noCookies: true
    },
    {
      label: "default-no-cookies",
      extractorArgs: null,
      noCookies: true
    }
  ];


  for (const t of targets) {
    const isYT = isYouTubeTarget(t.target) || t.target.startsWith("ytsearch");
    for (const strategy of clientStrategies) {
      // Only apply YouTube client strategies to YouTube targets
      if (strategy.extractorArgs && !isYT) {
        if (strategy.label !== "default") continue;
      }
      plans.push({
        label: `${t.sourceStrategy}-${strategy.label}`,
        target: t.target,
        sourceStrategy: t.sourceStrategy,
        extractorArgs: strategy.extractorArgs || undefined,
        format: strategy.format || undefined,
        noCookies: strategy.noCookies || false
      });
    }
  }

  // SoundCloud fallback (opt-in, always last)
  if (useSoundCloudFallback && trimmedQuery && !isUrl(trimmedQuery)) {
    plans.push({
      label: "soundcloud-search",
      target: `scsearch1:${trimmedQuery}`,
      sourceStrategy: "soundcloud"
    });
  }

  return plans;
}

function buildYtDlpDownloadArgs(plan, musicDir, options = {}) {
  const template = path.join(musicDir, "%(title).200s.%(ext)s");
  const args = [
    ...buildYtDlpBaseArgs(options, plan),
    "--rm-cache-dir",
    "--no-check-certificates",
    "--force-overwrites",
    "--no-continue",
    "--retries",
    "3",
    "--fragment-retries",
    "3"
  ];

  const format = plan.format || options.format;
  if (format) {
    args.push("--format", format);
  }

  args.push(
    "--no-playlist",
    "--print",
    "after_move:filepath",
    "-o",
    template,
    plan.target
  );

  return args;
}

function spawnYtDlp(ytDlpBin, ytDlpBinArgs, args) {
  return spawn(ytDlpBin, [...(ytDlpBinArgs || []), ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function runYtDlpDownload(ytDlpBin, ytDlpBinArgs, plan, musicDir, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildYtDlpDownloadArgs(plan, musicDir, options);
    console.log(`[yt-dlp] Trying plan "${plan.label}" → ${plan.target}`);
    const child = spawnYtDlp(ytDlpBin, ytDlpBinArgs, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(wrapSpawnError(error)));
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(makeExitError(stderr, code, plan.label, plan.target));
        return;
      }

      const downloadedPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!downloadedPath) {
        reject(new Error(`yt-dlp did not report a downloaded file path for ${plan.target}`));
        return;
      }

      try {
        const stat = await fs.promises.stat(downloadedPath);
        if (!stat.isFile() || stat.size === 0) {
          reject(new Error(`Downloaded file is empty: ${downloadedPath}`));
          return;
        }
        console.log(`[yt-dlp] Success with plan "${plan.label}" → ${downloadedPath}`);
        resolve(downloadedPath);
      } catch {
        reject(new Error(`Downloaded file not found: ${downloadedPath}`));
      }
    });
  });
}

async function downloadWithYtDlp({
  ytDlpBin,
  ytDlpBinArgs,
  query,
  url,
  musicDir,
  jsRuntime,
  remoteComponents,
  extractorArgs,
  impersonate,
  cookies,
  cookiesFromBrowser,
  useOauth2,
  soundCloudFallback,
  format
}) {
  const plans = buildDownloadPlans(query, url, { extractorArgs, soundCloudFallback });
  const errors = [];
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser,
    useOauth2,
    soundCloudFallback,
    format
  };

  if (plans.length === 0) {
    throw new Error("No query or URL was provided for remote download.");
  }

  for (const plan of plans) {
    try {
      const downloadedPath = await runYtDlpDownload(ytDlpBin, ytDlpBinArgs, plan, musicDir, options);
      return {
        path: downloadedPath,
        candidate: {
          url: plan.target,
          title: query,
          sourceStrategy: plan.sourceStrategy,
          downloadStrategy: plan.label
        }
      };
    } catch (error) {
      errors.push({ label: plan.label, message: error.message });
    }
  }

  throw combineAttemptErrors(errors, options);
}

function runYtDlpSearch(ytDlpBin, ytDlpBinArgs, target, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...buildYtDlpBaseArgs(options),
      "-j",
      "--flat-playlist",
      target
    ];

    const child = spawnYtDlp(ytDlpBin, ytDlpBinArgs, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(wrapSpawnError(error)));
    child.on("close", (code) => {
      if (code !== 0 && stdout.trim() === "") {
        reject(makeExitError(stderr, code, "search", target));
        return;
      }

      const results = [];
      const lines = stdout.trim().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        try {
          results.push(JSON.parse(line));
        } catch {
          // ignore
        }
      }
      resolve(results);
    });
  });
}

async function searchRemoteWithYtDlp({
  ytDlpBin,
  ytDlpBinArgs,
  query,
  jsRuntime,
  remoteComponents,
  extractorArgs,
  impersonate,
  cookies,
  cookiesFromBrowser,
  useOauth2
}) {
  const target = `ytsearch5:${query}`;
  const options = {
    jsRuntime,
    remoteComponents,
    extractorArgs,
    impersonate,
    cookies,
    cookiesFromBrowser,
    useOauth2
  };

  const results = await runYtDlpSearch(ytDlpBin, ytDlpBinArgs, target, options);
  return results.map(r => ({
    id: r.id,
    title: r.title,
    channel: r.uploader || r.channel,
    duration: r.duration,
    thumbnail: r.thumbnails && r.thumbnails.length ? r.thumbnails[r.thumbnails.length - 1].url : r.thumbnail,
    url: r.url || (r.id ? `https://www.youtube.com/watch?v=${r.id}` : null)
  })).filter(r => r.url);
}

async function findBestAudioCandidate({ query }) {
  const [plan] = buildDownloadPlans(query);
  if (!plan) throw new Error("No query provided");
  return {
    url: plan.target,
    title: query,
    sourceStrategy: plan.sourceStrategy,
    score: plan.sourceStrategy === "search" ? 100 : 0
  };
}

module.exports = {
  downloadWithYtDlp,
  searchRemoteWithYtDlp,
  findBestAudioCandidate,
  buildYtDlpBaseArgs,
  buildYtDlpDownloadArgs,
  buildDownloadPlans,
  spawnYtDlp
};
