const { config } = require("../src/config");
const { createDatabase } = require("../src/database");
const { scanLibrary } = require("../src/library");

async function main() {
  const db = createDatabase(config.dbPath);
  const tracks = await scanLibrary(db, config.musicDir);
  console.log(`Indexed ${tracks.length} track${tracks.length === 1 ? "" : "s"} from ${config.musicDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
