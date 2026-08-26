require("dotenv/config");

const { PrismaClient } = require("@prisma/client");

const OLD_HOST = "cdn-static.weebin.site";

const prisma = new PrismaClient();

const targets = [
  { model: "anime", label: "Anime.thumbnail", field: "thumbnail" },
  { model: "anime", label: "Anime.bigCover", field: "bigCover" },
  { model: "episode", label: "Episode.thumbnail", field: "thumbnail" },
  { model: "user", label: "User.avatar", field: "avatar" },
];

function isWriteMode() {
  return process.argv.includes("--write");
}

function toStoragePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const url = new URL(value.trim());
    if (url.hostname !== OLD_HOST) return null;

    const path = `${url.pathname.replace(/^\/+/, "")}${url.search}${url.hash}`;
    return path || null;
  } catch {
    return null;
  }
}

async function migrateTarget(target, write) {
  const delegate = prisma[target.model];
  const rows = await delegate.findMany({
    where: {
      [target.field]: {
        contains: OLD_HOST,
      },
    },
    select: {
      id: true,
      [target.field]: true,
    },
  });

  let changed = 0;
  let skipped = 0;

  for (const row of rows) {
    const nextValue = toStoragePath(row[target.field]);

    if (!nextValue || nextValue === row[target.field]) {
      skipped += 1;
      continue;
    }

    changed += 1;

    if (write) {
      await delegate.update({
        where: { id: row.id },
        data: { [target.field]: nextValue },
      });
    }
  }

  console.log(
    `${target.label}: matched=${rows.length} changed=${changed} skipped=${skipped}`,
  );
}

async function main() {
  const write = isWriteMode();

  console.log(
    write
      ? "Running CDN image path migration in write mode."
      : "Running CDN image path migration in dry-run mode. Add --write to update DB.",
  );

  for (const target of targets) {
    await migrateTarget(target, write);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
