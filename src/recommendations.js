function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return new Set(normalize(text).split(" ").filter((token) => token.length > 2));
}

function genreSet(track) {
  return tokens(track.genre || "");
}

function scoreSimilarity(seed, candidate) {
  if (!seed || !candidate || seed.id === candidate.id) return 0;

  let score = 0;
  if (seed.artist && candidate.artist && normalize(seed.artist) === normalize(candidate.artist)) score += 100;
  if (seed.album && candidate.album && normalize(seed.album) === normalize(candidate.album)) score += 45;

  const seedGenres = genreSet(seed);
  const candidateGenres = genreSet(candidate);
  for (const genre of seedGenres) {
    if (candidateGenres.has(genre)) score += 40;
  }

  const seedWords = tokens(`${seed.title} ${seed.artist} ${seed.album}`);
  const candidateWords = tokens(`${candidate.title} ${candidate.artist} ${candidate.album}`);
  for (const word of seedWords) {
    if (candidateWords.has(word)) score += 8;
  }

  return score;
}

function similarTracks(db, seedId, { excludeIds = [], limit = 12 } = {}) {
  const seed = db.getTrack(seedId);
  if (!seed) return [];

  const excluded = new Set([seed.id, ...excludeIds.map(Number).filter(Number.isFinite)]);
  const scored = db.listTracks()
    .filter((track) => !excluded.has(track.id))
    .map((track) => ({
      ...track,
      recommendationScore: scoreSimilarity(seed, track)
    }))
    .sort((a, b) =>
      b.recommendationScore - a.recommendationScore ||
      String(b.last_played_at || "").localeCompare(String(a.last_played_at || "")) ||
      String(a.title).localeCompare(String(b.title))
    );

  const strongMatches = scored.filter((track) => track.recommendationScore > 0);
  const fallback = scored.filter((track) => track.recommendationScore === 0);
  return [...strongMatches, ...fallback].slice(0, limit);
}

module.exports = { similarTracks };
