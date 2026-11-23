/* =============================================================================
   family-notion · Cloudflare Worker (전체 교체판)
   -----------------------------------------------------------------------------
   기존 기능 그대로 + 「📔 세줄일기」(/diary) 추가
     GET  /diary                → 최근 일기 30편(본문 3줄 + 사진 URL 포함)
     GET  /diary?month=2026-11  → 그 달 일기 전부
     GET  /diary?meta=1         → 목록용 가벼운 정보(제목·날짜·태그·요약) 전체
     POST /diary                → 새 일기 저장 / {id} 를 주면 그 일기 수정

   배포 방법
     1) Cloudflare 대시보드 → Workers & Pages → family-notion → 편집(Quick edit)
     2) 이 파일 내용으로 전부 바꿔 넣고 [Deploy]
     3) Settings → Variables 에 아래가 있는지 확인
          NOTION_TOKEN   (필수, 기존과 동일)
          BOOK_DB_ID, MAILBOX_DB_ID, MEAL_DB_ID (기존 그대로)
          DIARY_DB_ID    (선택 — 없으면 아래 기본값 4208d929-… 사용)
     4) 노션에서 「📔 세줄일기」 데이터베이스가 이 연동(Connection)에 공유돼 있어야 함.

   ※ 무료 플랜은 요청 1회당 서브요청 50개 제한 → 목록은 한 번에 최대 40편까지만
     본문을 읽고, 그 이상은 ?month= 또는 커서로 나눠 읽습니다.
   ============================================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NOTION_VERSION = "2022-06-28";
const DIARY_DB_FALLBACK = "4208d929-53b6-8060-bd8a-d05eb1ad6363";

/* 노션 「📔 세줄일기」 속성 이름 */
const DP = {
  title: "제목",
  date: "날짜",
  summary: "한줄 요약",
  together: "함께", // multi_select — 태그로 함께 사용 (가족·은호·은비·호성 …)
  category: "분류", // select — 일상·모임 / 학교·행사 / 체험·여행
};

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
  });
}

async function notionRequest(token, path, method = "GET", body = null) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.message ? data.message : `Notion API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function createNotionPage(token, payload) {
  return notionRequest(token, "/pages", "POST", payload);
}

/* ---------- 공통 값 읽기 ---------- */

function plainText(rich) {
  return (rich || []).map((r) => r.plain_text || (r.text && r.text.content) || "").join("").trim();
}

function titleOf(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title)) return plainText(prop.title);
  if (Array.isArray(prop.rich_text)) return plainText(prop.rich_text);
  return "";
}

function toIsoKst(ms) {
  if (!ms) return "";
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}

function todayKst() {
  return toIsoKst(Date.now()).slice(0, 10);
}

function normDate(v) {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function nextMonthFirst(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m 은 1-based → 다음 달
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/* ---------- 대시보드용: 책 리뷰 · 우체통 ---------- */

function bookReviewItem(page) {
  const p = page.properties || {};
  const date = p["기록일"] && p["기록일"].date ? p["기록일"].date.start || "" : "";
  const edited = Date.parse(page.last_edited_time || "");
  const atMs = Number.isFinite(edited) ? edited : Date.parse(`${date}T12:00:00+09:00`);
  return {
    id: page.id,
    title: titleOf(p["책 제목"]),
    rating: Number((p["별점"] && p["별점"].number) || 0),
    review: plainText(p["한마디"] && p["한마디"].rich_text),
    completed: Boolean(p["완독 여부"] && p["완독 여부"].checkbox),
    date,
    at: toIsoKst(atMs),
    atMs: atMs,
    source: "notion",
  };
}

function mailboxItem(page) {
  const p = page.properties || {};
  const date = p["작성일"] && p["작성일"].date ? p["작성일"].date.start || "" : "";
  const edited = Date.parse(page.last_edited_time || "");
  const atMs = Number.isFinite(edited) ? edited : Date.parse(`${date}T12:00:00+09:00`);
  const content = plainText(p["내용"] && p["내용"].rich_text);
  const title = titleOf(p["제목"]);
  return {
    id: page.id,
    title,
    text: content || title,
    author: (p["작성자"] && p["작성자"].select && p["작성자"].select.name) || "은호",
    date,
    at: toIsoKst(atMs),
    atMs: atMs,
    source: "notion",
  };
}

/* ---------- 데이터베이스 조회 ---------- */

async function queryAll(token, databaseId, options) {
  const opts = Array.isArray(options) ? { sorts: options } : options || {};
  const { sorts, filter, maxPages = 5, pageSize = 100 } = opts;
  let cursor = null;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const body = { page_size: pageSize };
    if (sorts) body.sorts = sorts;
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(token, `/databases/${databaseId}/query`, "POST", body);
    out.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- 📔 세줄일기 ---------- */

function diaryDbId(env) {
  return env.DIARY_DB_ID || env.DIARY_DB || DIARY_DB_FALLBACK;
}

function diaryTags(p) {
  const together = (p[DP.together] && p[DP.together].multi_select) || [];
  const tags = together.map((o) => o.name).filter(Boolean);
  const cat = p[DP.category] && p[DP.category].select && p[DP.category].select.name;
  if (cat && !tags.includes(cat)) tags.push(cat);
  return tags;
}

/* 목록용 (본문 없이) */
function lightEntry(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    title: titleOf(p[DP.title]),
    date: normDate(p[DP.date] && p[DP.date].date && p[DP.date].date.start),
    tags: diaryTags(p),
    summary: plainText(p[DP.summary] && p[DP.summary].rich_text),
    url: page.url || "",
    edited: page.last_edited_time || "",
  };
}

const TEXT_TYPES = ["paragraph", "heading_1", "heading_2", "heading_3", "quote", "bulleted_list_item", "numbered_list_item", "callout", "toggle"];

function isTextBlock(b) {
  return b && TEXT_TYPES.includes(b.type);
}

function blockText(b) {
  const v = b[b.type];
  if (!v) return "";
  if (Array.isArray(v.rich_text)) return plainText(v.rich_text);
  return "";
}

/* 본문 블록 → 세 줄 + 사진 */
function bodyOf(children) {
  const lines = [];
  const photos = [];
  for (const b of children) {
    if (!b || b.archived) continue;
    if (b.type === "image") {
      const img = b.image || {};
      const src =
        img.type === "external" ? img.external && img.external.url :
        img.type === "file" ? img.file && img.file.url :
        (img.file_upload && img.file_upload.url) || "";
      if (src) photos.push({ id: b.id, url: src, caption: plainText(img.caption) });
      continue;
    }
    if (isTextBlock(b)) {
      const txt = blockText(b);
      if (!txt) continue;
      for (const part of txt.split(/\n+/)) {
        const t = part.trim();
        if (t) lines.push(t);
      }
    }
  }
  return { lines, photos };
}

function diaryEntry(page, children) {
  const base = lightEntry(page);
  const { lines, photos } = bodyOf(children);
  return { ...base, lines, photos };
}

async function fetchChildren(token, blockId, maxPages = 1) {
  let cursor = null;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notionRequest(token, `/blocks/${blockId}/children?${q.toString()}`, "GET");
    out.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: String(text).slice(0, 1900) } }] },
  };
}

function imageUploadBlock(uploadId, caption) {
  const block = {
    object: "block",
    type: "image",
    image: { type: "file_upload", file_upload: { id: uploadId } },
  };
  if (caption) block.image.caption = [{ type: "text", text: { content: String(caption).slice(0, 200) } }];
  return block;
}

function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* 사진(dataURL) → 노션 파일 업로드 */
async function uploadImage(token, dataUrl, filename) {
  const m = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new Error("사진 형식을 읽지 못했어요");
  const contentType = m[1] || "image/jpeg";
  const bytes = base64ToBytes(m[2]);
  if (!bytes.length) throw new Error("사진이 비어 있어요");
  if (bytes.length > 15 * 1024 * 1024) throw new Error("사진이 너무 커요");

  const created = await notionRequest(token, "/file_uploads", "POST", {
    filename: filename || `diary-${Date.now()}.jpg`,
    content_type: contentType,
  });

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename || "diary.jpg");
  const sendUrl = created.upload_url || `https://api.notion.com/v1/file_uploads/${created.id}/send`;
  const res = await fetch(sendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    body: form,
  });
  const sent = await res.json().catch(() => ({}));
  const status = sent && sent.status;
  if (!res.ok || (status && status !== "uploaded")) {
    throw new Error((sent && sent.message) || `사진 업로드 실패 (${res.status})`);
  }
  return created.id;
}

const CATEGORY_OPTIONS = ["일상·모임", "학교·행사", "체험·여행"];

function diaryProperties({ title, date, tags, summary }) {
  const category = tags.find((t) => CATEGORY_OPTIONS.includes(t)) || null;
  const props = {
    [DP.title]: { title: [{ type: "text", text: { content: title.slice(0, 1900) } }] },
    [DP.date]: { date: { start: date } },
    [DP.summary]: { rich_text: summary ? [{ type: "text", text: { content: summary.slice(0, 1900) } }] : [] },
    [DP.together]: { multi_select: tags.map((t) => ({ name: String(t).slice(0, 90) })) },
    /* 태그에 분류(일상·모임/학교·행사/체험·여행)가 있으면 분류 칸도 맞춰 준다 */
    [DP.category]: { select: category ? { name: category } : null },
  };
  return props;
}

async function appendChildren(token, blockId, children) {
  if (!children.length) return [];
  const out = [];
  for (let i = 0; i < children.length; i += 90) {
    const chunk = children.slice(i, i + 90);
    const data = await notionRequest(token, `/blocks/${blockId}/children`, "PATCH", { children: chunk });
    out.push(...(data.results || []));
  }
  return out;
}

async function archiveBlock(token, blockId) {
  try {
    await notionRequest(token, `/blocks/${blockId}`, "PATCH", { archived: true });
  } catch (e) {
    /* 이미 지워졌거나 권한이 없으면 넘어간다 */
  }
}

async function findSameDiary(token, db, title, date) {
  const data = await notionRequest(token, `/databases/${db}/query`, "POST", {
    filter: {
      and: [
        { property: DP.title, title: { equals: title } },
        { property: DP.date, date: { equals: date } },
      ],
    },
    page_size: 1,
  });
  return (data.results || [])[0] || null;
}

async function handleDiaryPost(env, body) {
  const token = env.NOTION_TOKEN;
  const db = diaryDbId(env);
  const warnings = [];

  const titleRaw = String(body.title || "").trim();
  const date = normDate(body.date) || todayKst();
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .map((s) => String(s == null ? "" : s).trim())
    .filter(Boolean)
    .slice(0, 20);
  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map((t) => String(t == null ? "" : t).replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const title = (titleRaw || lines[0] || "제목 없음").slice(0, 200);
  const summary = String(body.summary || lines[0] || "").trim().slice(0, 200);

  if (!lines.length && !titleRaw && !summary) {
    return jsonResponse({ ok: false, error: "제목이나 세 줄 중 하나는 필요해요" }, 400);
  }

  const photosInput = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
  const newPhotoBlocks = [];
  for (const p of photosInput) {
    if (p && p.data) {
      try {
        const uploadId = await uploadImage(token, p.data, p.filename || undefined);
        newPhotoBlocks.push(imageUploadBlock(uploadId, p.caption));
      } catch (e) {
        warnings.push("사진 1장은 노션에 올리지 못했어요");
      }
    }
  }
  const keepPhotoIds = photosInput.filter((p) => p && p.id).map((p) => String(p.id));

  let pageId = String(body.id || "");

  /* id 가 없으면 같은 제목·날짜의 일기가 이미 있는지 확인 (재시도로 인한 중복 방지) */
  if (!pageId) {
    const same = await findSameDiary(token, db, title, date);
    if (same) pageId = same.id;
  }

  if (!pageId) {
    const children = [...lines.map(paragraphBlock), ...newPhotoBlocks];
    const page = await createNotionPage(token, {
      parent: { database_id: db },
      properties: diaryProperties({ title, date, tags, summary }),
      children: children.slice(0, 90),
    });
    return jsonResponse({ ok: true, id: page.id, created: true, warnings }, 200, { "Cache-Control": "no-store" });
  }

  /* 수정: 속성 바꾸고, 본문 문단은 자리를 지킨 채 글자만 교체 */
  await notionRequest(token, `/pages/${pageId}`, "PATCH", {
    properties: diaryProperties({ title, date, tags, summary }),
  });

  const kids = await fetchChildren(token, pageId);
  const texts = kids.filter(isTextBlock);

  for (let i = 0; i < lines.length; i++) {
    if (i < texts.length) {
      if (blockText(texts[i]) !== lines[i]) {
        await notionRequest(token, `/blocks/${texts[i].id}`, "PATCH", {
          [texts[i].type]: { rich_text: [{ type: "text", text: { content: lines[i].slice(0, 1900) } }] },
        });
      }
    } else {
      await appendChildren(token, pageId, [paragraphBlock(lines[i])]);
    }
  }
  for (let i = lines.length; i < texts.length; i++) {
    await archiveBlock(token, texts[i].id);
  }

  /* 사진: 앱이 목록을 보내 왔을 때만 정리(빼기), 새 사진은 뒤에 붙임 */
  if (Array.isArray(body.photos)) {
    const keep = new Set(keepPhotoIds);
    for (const b of kids) {
      if (b.type === "image" && !keep.has(b.id)) await archiveBlock(token, b.id);
    }
  }
  if (newPhotoBlocks.length) await appendChildren(token, pageId, newPhotoBlocks);

  return jsonResponse({ ok: true, id: pageId, updated: true, warnings }, 200, { "Cache-Control": "no-store" });
}

/* =============================== Worker =============================== */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const cache = { "Cache-Control": "public, max-age=60" };

    if (!env || !env.NOTION_TOKEN) {
      return jsonResponse({ ok: false, error: "NOTION_TOKEN 이 설정되지 않았어요" }, 500);
    }

    /* ---- 읽기 ---- */
    if (request.method === "GET") {
      try {
        if (url.pathname === "/book-reviews") {
          const pages = await queryAll(env.NOTION_TOKEN, env.BOOK_DB_ID, {
            sorts: [{ property: "기록일", direction: "ascending" }],
          });
          return jsonResponse({ ok: true, items: pages.map(bookReviewItem) }, 200, cache);
        }

        if (url.pathname === "/mailbox") {
          const pages = await queryAll(env.NOTION_TOKEN, env.MAILBOX_DB_ID, {
            sorts: [{ property: "작성일", direction: "ascending" }],
          });
          return jsonResponse({ ok: true, items: pages.map(mailboxItem) }, 200, cache);
        }

        /* 📔 세줄일기 */
        if (url.pathname === "/diary" || url.pathname === "/diary/") {
          const db = diaryDbId(env);
          const meta = url.searchParams.get("meta") === "1";
          const monthParam = url.searchParams.get("month") || "";
          const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : "";

          /* 목록용 가벼운 정보 */
          if (meta) {
            const pages = await queryAll(env.NOTION_TOKEN, db, {
              sorts: [{ property: DP.date, direction: "descending" }],
              maxPages: 5,
            });
            return jsonResponse({ ok: true, items: pages.map(lightEntry) }, 200, {
              "Cache-Control": "public, max-age=120",
            });
          }

          const opts = {
            sorts: [{ property: DP.date, direction: "descending" }],
            maxPages: 1,
            pageSize: month ? 100 : 30,
          };
          if (month) {
            opts.filter = {
              and: [
                { property: DP.date, date: { on_or_after: `${month}-01` } },
                { property: DP.date, date: { before: nextMonthFirst(month) } },
              ],
            };
          }
          const pages = await queryAll(env.NOTION_TOKEN, db, opts);

          /* 무료 플랜 서브요청 한도(50) 때문에 한 번에 40편까지만 본문을 읽는다 */
          const targets = pages.slice(0, 40);
          const kids = await mapLimit(targets, 5, (p) => fetchChildren(env.NOTION_TOKEN, p.id, 1));
          const items = targets.map((p, i) => diaryEntry(p, kids[i] || []));
          const rest = pages.slice(40).map(lightEntry);
          return jsonResponse({ ok: true, items: items.concat(rest), scope: month || "recent" }, 200, cache);
        }

        if (url.pathname === "/" || url.pathname === "/status") {
          return jsonResponse({
            ok: true,
            name: "family-notion",
            live: ["/book-reviews", "/mailbox", "/diary", "/diary?month=YYYY-MM", "/diary?meta=1"],
          });
        }
        return jsonResponse({ ok: false, error: "Unknown route" }, 404);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
    }

    const today = todayKst();

    try {
      if (url.pathname === "/book-review") {
        const title = String(body.title || "").trim() || "제목 없음";
        const rating = Number(body.rating || 0);
        const comment = String(body.comment || "").trim();
        const completed = Boolean(body.completed);
        const date = String(body.date || today).slice(0, 10);

        const properties = {
          "책 제목": { title: [{ text: { content: title } }] },
          "별점": { number: rating },
          "한마디": { rich_text: comment ? [{ text: { content: comment } }] : [] },
          "완독 여부": { checkbox: completed },
          "기록일": { date: { start: date } },
        };

        const page = await createNotionPage(env.NOTION_TOKEN, {
          parent: { database_id: env.BOOK_DB_ID },
          properties,
        });
        return jsonResponse({ ok: true, id: page.id });
      }

      if (url.pathname === "/mailbox") {
        const content = String(body.content || "").trim();
        const title =
          String(body.title || "").trim() ||
          (content.length > 30 ? content.slice(0, 30) + "…" : content) ||
          "새 우체통 글";
        const author = ["은호", "엄마", "아빠"].includes(body.author) ? body.author : "은호";
        const date = String(body.date || today).slice(0, 10);

        const properties = {
          "제목": { title: [{ text: { content: title } }] },
          "내용": { rich_text: content ? [{ text: { content: content } }] : [] },
          "작성자": { select: { name: author } },
          "작성일": { date: { start: date } },
        };

        const page = await createNotionPage(env.NOTION_TOKEN, {
          parent: { database_id: env.MAILBOX_DB_ID },
          properties,
        });
        return jsonResponse({ ok: true, id: page.id });
      }

      /* 🍱 오늘 점심 메뉴 하트 — 「은호 급식 좋아요」 DB */
      if (url.pathname === "/meal-like") {
        const menu = String(body.menu || "").trim();
        const date = String(body.date || today).slice(0, 10);
        const liked = body.liked !== false;
        if (!menu) {
          return jsonResponse({ ok: false, error: "menu required" }, 400);
        }

        const found = await notionRequest(env.NOTION_TOKEN, `/databases/${env.MEAL_DB_ID}/query`, "POST", {
          filter: {
            and: [
              { property: "메뉴명", title: { equals: menu } },
              { property: "날짜", date: { equals: date } },
            ],
          },
          page_size: 1,
        });

        const existing = (found.results || [])[0];
        if (existing) {
          await notionRequest(env.NOTION_TOKEN, `/pages/${existing.id}`, "PATCH", {
            properties: { "좋아요": { checkbox: liked } },
          });
          return jsonResponse({ ok: true, id: existing.id, updated: true, liked });
        }

        if (!liked) {
          return jsonResponse({ ok: true, skipped: true, liked: false });
        }

        const page = await createNotionPage(env.NOTION_TOKEN, {
          parent: { database_id: env.MEAL_DB_ID },
          properties: {
            "메뉴명": { title: [{ text: { content: menu } }] },
            "날짜": { date: { start: date } },
            "좋아요": { checkbox: true },
          },
        });
        return jsonResponse({ ok: true, id: page.id, liked: true });
      }

      /* 📔 세줄일기 저장 / 수정 */
      if (url.pathname === "/diary" || url.pathname === "/diary/") {
        return await handleDiaryPost(env, body);
      }

      return jsonResponse({ ok: false, error: "Unknown route" }, 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
