// Capture the current Electron UI with generated, fictional data in an isolated profile.
// Run `npm run build` first. Never uses the normal Javdex userData directory.
import { _electron } from "playwright-core";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const readme = process.argv.includes("--readme");
const profile = path.join(root, "output/playwright/website-product-profile");
const screenshots = path.join(
  root,
  readme ? "docs/images" : "website/assets/screenshots",
);
const films = [
  [
    "city",
    "夜行城市",
    "她在雨夜重返熟悉的街区，沿着一封旧信，寻找城市里被遗忘的记忆。",
  ],
  [
    "sea",
    "潮汐之后",
    "离开多年后，她回到海边的旧居，在潮起潮落之间，重新理解家与远方。",
  ],
  [
    "forest",
    "山野来信",
    "一封来自山间小站的信，让一段停留在记忆里的旅程再次开始。",
  ],
  [
    "cinema",
    "旧影院",
    "最后一场放映前，年轻的放映员与一座老影院，静静告别一个时代。",
  ],
  [
    "blue",
    "蓝色时刻",
    "摄影师来到山间湖畔，在日夜交接的短暂时刻，找到重新出发的勇气。",
  ],
  [
    "rain",
    "雨幕信号",
    "一场大雨让两条陌生的旅途在旧车站交汇，未能寄出的信终于有了归处。",
  ],
];
await mkdir(path.join(profile, "media_assets/covers"), { recursive: true });
await mkdir(screenshots, { recursive: true });
for (const [key] of films) {
  for (const type of ["Cover", "Bg"]) {
    await copyFile(
      path.join(root, `website/assets/artwork/${key}${type}.webp`),
      path.join(profile, `media_assets/covers/${key}${type}.webp`),
    );
  }
}
await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({ theme: "light", coverDisplayMode: "portrait" }),
);
const env = { ...process.env, JAVDEX_TEST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  args: [path.join(root, "website/scripts/capture-entry.cjs")],
  env,
});
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 850),
  );
  await page.waitForFunction(() => !!window.api);
  await app.evaluate(
    ({ app }, { root, films }) => {
      const require = globalThis.captureRequire;
      const db = new (require(root + "/node_modules/better-sqlite3"))(
        require("node:path").join(app.getPath("userData"), "data/library.db"),
      );
      if (!db.prepare("SELECT count(*) AS n FROM videos").get().n) {
        db.transaction(() => {
          db.prepare(
            "UPDATE media_libraries SET name='我的收藏',icon='film',color='blue' WHERE id=1",
          ).run();
          db.prepare(
            "INSERT INTO media_libraries(id,name,icon,color) VALUES(2,'待看影片','star','amber')",
          ).run();
          db.prepare(
            "INSERT INTO media_library_configs(library_id) VALUES(2)",
          ).run();
          db.prepare(
            "INSERT INTO actresses(id,main_name,profile_summary,scraped_status) VALUES(1,'林澄','虚构演示人物，出演城市与自然主题作品。',1)",
          ).run();
          db.prepare(
            "INSERT INTO actress_names(actress_id,name,type) VALUES(1,'林澄','main')",
          ).run();
          db.prepare(
            "INSERT INTO directors(id,main_name) VALUES(1,'许言')",
          ).run();
          db.prepare(
            "INSERT INTO organizations(id,main_name) VALUES(1,'拾光影像')",
          ).run();
          db.prepare(
            "INSERT INTO organization_roles(organization_id,role) VALUES(1,'maker'),(1,'publisher')",
          ).run();
          db.prepare(
            "INSERT INTO series(id,main_name) VALUES(1,'光与时间')",
          ).run();
          db.prepare(
            "INSERT INTO tags(id,name) VALUES(1,'剧情'),(2,'旅行'),(3,'收藏精选')",
          ).run();
          for (const [i, [key, title, summary]] of films.entries()) {
            const id = i + 1;
            db.prepare(
              "INSERT INTO videos(id,code,title,summary,cover_path,poster_path,rating,release_date,duration_seconds,scraped_status,maker_organization_id,publisher_organization_id,director_id,series_id) VALUES(?,?,?,?,?,?,?,?,?,1,1,1,1,1)",
            ).run(
              id,
              `DEMO-00${id}`,
              title,
              summary,
              `covers/${key}Cover.webp`,
              `covers/${key}Bg.webp`,
              4,
              `2025-0${6 - i}-01`,
              (96 + i * 4) * 60,
            );
            db.prepare(
              "INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(1,?,?)",
            ).run(id, id * 13001);
            db.prepare(
              "INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,display_name,is_primary) VALUES(1,?,'web',?,?,?,1)",
            ).run(
              id,
              `https://example.com/demo/${id}`,
              `demo-${id}`,
              `${title} · 演示链接`,
            );
            db.prepare(
              "INSERT INTO video_actress(video_id,actress_id) VALUES(?,1)",
            ).run(id);
            db.prepare(
              "INSERT INTO video_tag(video_id,tag_id) VALUES(?,?)",
            ).run(id, (i % 3) + 1);
          }
          db.prepare(
            "INSERT INTO playlists(id,name,description,cover_path) VALUES(1,'光与时间','从一座城市到一片海岸，把想再次回看的作品放在一起。','covers/cityCover.webp')",
          ).run();
          for (let i = 1; i <= 6; i++)
            db.prepare(
              "INSERT INTO playlist_video(playlist_id,video_id,position) VALUES(1,?,?)",
            ).run(i, i);
        })();
      }
      db.close();
    },
    { root, films },
  );
  await page.reload();
  async function route(route, name) {
    await page.evaluate((value) => {
      location.hash = value;
    }, route);
    await page.waitForTimeout(700);
    await page.evaluate(async () => {
      const images = [...document.images];
      images.forEach((i) => (i.loading = "eager"));
      await Promise.all(
        images
          .filter((i) => i.getAttribute("src"))
          .map((i) => i.decode().catch(() => {})),
      );
      await document.fonts.ready;
    });
    await page.screenshot({
      path: path.join(screenshots, `${name}.png`),
      scale: "css",
    });
  }
  await route("/libraries/1", "library");
  if (readme) {
    await page.evaluate(() =>
      window.api.settings.update({ theme: "graphite" }),
    );
    await page.reload();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 980),
    );
    await route("/libraries/1/video/3", "video-detail");
    console.log("Captured current README library and film detail views.");
  } else {
    await route("/libraries/1/video/1", "video-detail");
    await route("/playlists/1", "playlist");
    await route("/settings/plugins/video", "sources");
    await route("/settings/storage/export", "nfo");
    await page.getByRole("button", { name: "新建媒体库", exact: true }).click();
    await page.getByRole("textbox", { name: "媒体库名称" }).fill("影片收藏");
    await page.getByRole("button", { name: "影片", exact: true }).click();
    await page
      .getByRole("button", { name: "强调色：蓝色", exact: true })
      .click();
    for (let i = 1; i <= 4; i++) {
      await page.getByRole("dialog").screenshot({
        path: path.join(screenshots, `create-${i}.png`),
        scale: "css",
      });
      if (i < 4)
        await page.getByRole("button", { name: "下一步", exact: true }).click();
    }
    await page.keyboard.press("Escape");
    console.log(
      "Captured 9 current application views. Run optimize-assets.py before building the website.",
    );
  }
} finally {
  await app.close();
}
