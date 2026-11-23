/* =============================================================================
   family-notion · Cloudflare Worker (전체 교체판)
   -----------------------------------------------------------------------------
   기존 기능 그대로 + 「📔 세줄일기」(/diary) + 「🎮 학습·도감 상태」(/study-state) 추가
     GET  /diary                → 최근 일기 30편(본문 3줄 + 사진 URL 포함)   🔐 키 필요
     GET  /diary?month=2026-11  → 그 달 일기 전부                              🔐 키 필요
     GET  /diary?meta=1         → 목록용 가벼운 정보(제목·날짜·태그·요약) 전체    🔐 키 필요
     POST /diary                → 새 일기 저장 / {id} 를 주면 그 일기 수정       🔐 키 필요

   🔐 세줄일기 비밀키
     · /diary 는 요청 헤더 `X-Diary-Key` 가 맞아야 응답합니다 (없거나 틀리면 401 diary_auth_required).
     · 키는 DIARY_KEY_FALLBACK 기본값이나 Cloudflare Variables 의 DIARY_KEY 로 넣습니다.
       Cloudflare Variables 에 DIARY_KEY 를 넣으면 그 값이 우선입니다.
     · 대시보드용 /book-reviews · /mailbox · /study-state · /book-review · /meal-like 는 예전 그대로 열려 있습니다.
     · ⚠️ 이 저장소는 공개(Public)입니다. 실제 비밀키는 이 파일에 넣지 않습니다.
       실제 키를 넣은 배포본은 노션 「⚙️ Worker 코드 최신판」 페이지에만 둡니다.
       (DIARY_KEY_FALLBACK 이 비어 있으면 /diary 는 잠긴 채로 열리지 않습니다.)
     GET  /study-state          → 은호 학습·도감·아빠엄마 상태(JSON) 읽기
     POST /study-state          → 그 상태 저장(빈 기기가 기존 기록을 덮어쓰지 못하게 막음)

   배포 방법
     1) Cloudflare 대시보드 → Workers & Pages → family-notion → 편집(Quick edit)
     2) 이 파일 내용으로 전부 바꿔 넣고 [Deploy]
     3) Settings → Variables 에 아래가 있는지 확인
          NOTION_TOKEN   (필수, 기존과 동일)
          BOOK_DB_ID, MAILBOX_DB_ID, MEAL_DB_ID (기존 그대로)
          DIARY_DB_ID    (선택 — 없으면 아래 기본값 4208d929-… 사용)
          STUDY_PAGE_ID  (선택 — 없으면 아래 기본값 4218d929-… 사용)
     4) 노션에서 「📔 세줄일기」 데이터베이스와
        「🎮 은호 포켓몬·학습 상태」 페이지가 이 연동(Connection)에 공유돼 있어야 함
        (「이것저것 정보들」 페이지를 공유해 두면 그 아래 것도 함께 읽고 쓸 수 있음).

   ※ 무료 플랜은 요청 1회당 서브요청 50개 제한 → 목록은 한 번에 최대 40편까지만
     본문을 읽고, 그 이상은 ?month= 또는 커서로 나눠 읽습니다.
   ============================================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Diary-Key",
  "Access-Control-Max-Age": "86400",
};

const NOTION_VERSION = "2022-06-28";
const DIARY_DB_FALLBACK = "4208d929-53b6-8060-bd8a-d05eb1ad6363";

/* 🔐 세줄일기(/diary) 비밀키 --------------------------------------------------
   앱(index.html)은 한 번 입력한 키를 브라우저 localStorage 에 두고
   /diary 를 부를 때마다 X-Diary-Key 헤더로 보냅니다.
   · env.DIARY_KEY 가 있으면 그 값, 없으면 아래 기본값을 씁니다.
   · 키가 비어 있으면 /diary 는 잠긴 채로 둡니다 (fail closed). */
const DIARY_KEY_FALLBACK = "";

function diaryKeyOf(env) {
  return String((env && env.DIARY_KEY) || DIARY_KEY_FALLBACK || "").trim();
}

function diaryAuthorized(request, env) {
  const expected = diaryKeyOf(env);
  if (!expected) return false;
  const got = String(request.headers.get("X-Diary-Key") || "").trim();
  return got.length > 0 && got === expected;
}

function diaryUnauthorized() {
  return jsonResponse({ ok: false, error: "diary_auth_required" }, 401, { "Cache-Control": "no-store" });
}
/* 「🎮 은호 포켓몬·학습 상태 (자동 저장 · 지우지 마세요)」 페이지
   = 「이것저것 정보들」 아래, 대시보드의 학습·도감·아빠엄마 상태 JSON 을 담는 곳 */
const STUDY_PAGE_FALLBACK = "4218d929-53b6-818e-a302-df74a44e9fed";

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

/* ---------- 🎮 학습·도감 상태 (대시보드 여러 기기 동기화) 2026-11-23 ----------
   은호의 학습·포켓몬·아빠엄마 성장 상태를 노션 페이지 하나의 JSON 코드 블록에 저장한다.
   · 저장 위치: 「🎮 은호 포켓몬·학습 상태 (자동 저장 · 지우지 마세요)」 페이지의 code 블록
   · 빈 기기(0/1025)가 기존 기록을 덮어쓰지 않도록 빈 상태는 저장을 거부한다 (skipped:"blank")
   · 다른 기기가 더 최근에 저장했으면(base 보다 최신) conflict 로 최신 상태를 돌려준다 =
     기기는 그 상태와 자기 기록을 안전하게 합친 뒤 다시 올린다 */

function studyPageId(env) {
  return env.STUDY_PAGE_ID || env.STUDY_PAGE || STUDY_PAGE_FALLBACK;
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 긴 JSON → 노션 rich_text 조각(한 조각 1800자, 최대 99조각 = 약 17만8천자) */
function richTextChunks(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  for (let i = 0; i < s.length && out.length < 99; i += 1800) {
    out.push({ type: "text", text: { content: s.slice(i, i + 1800) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

/* 빈 상태(기기에 아무 기록도 없는 0/1025 상태)인지 */
function isBlankState(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const st = snap.study && typeof snap.study === "object" ? snap.study : {};
  const pa = snap.parents && typeof snap.parents === "object" ? snap.parents : {};
  if (st.partner) return false;
  if (numOr0(st.eggXp) > 0) return false;
  const lines = st.lines && typeof st.lines === "object" ? st.lines : {};
  for (const k of Object.keys(lines)) {
    if (numOr0(lines[k] && lines[k].xp) > 0) return false;
  }
  if (Array.isArray(st.ranch) && st.ranch.length) return false;
  const days = st.days && typeof st.days === "object" ? st.days : {};
  for (const d of Object.keys(days)) {
    const done = (days[d] && days[d].done) || {};
    if (Object.keys(done).some((q) => done[q])) return false;
  }
  if (st.postponed && Object.keys(st.postponed).length) return false;
  const seen = snap.dexSeen && typeof snap.dexSeen === "object" ? snap.dexSeen : {};
  if (Object.keys(seen).length) return false;
  if (numOr0(pa.xp && pa.xp.dad) > 0 || numOr0(pa.xp && pa.xp.mom) > 0) return false;
  if (pa.poke && (pa.poke.dad || pa.poke.mom)) return false;
  const pranch = pa.ranch && typeof pa.ranch === "object" ? pa.ranch : {};
  if ((Array.isArray(pranch.dad) && pranch.dad.length) || (Array.isArray(pranch.mom) && pranch.mom.length)) return false;
  const pdays = pa.days && typeof pa.days === "object" ? pa.days : {};
  for (const d of Object.keys(pdays)) {
    const rec = pdays[d] || {};
    for (const who of ["dad", "mom"]) {
      const m = rec[who] || {};
      if (Object.keys(m).some((k) => m[k])) return false;
    }
  }
  return true;
}

/* 페이지의 code 블록 하나를 상태 저장소로 쓴다 */
async function readStudyState(token, pageId) {
  const kids = await fetchChildren(token, pageId, 2);
  const block = kids.find((b) => b && !b.archived && b.type === "code") || null;
  if (!block) return { block: null, state: null };
  const text = plainText(block.code && block.code.rich_text);
  if (!text) return { block, state: null };
  let state = null;
  try { state = JSON.parse(text); } catch (err) { state = null; }
  if (!state || typeof state !== "object" || Array.isArray(state)) return { block, state: null };
  return { block, state };
}

async function writeStudyState(token, pageId, state, knownBlock) {
  const json = JSON.stringify(state);
  let blockId = knownBlock && knownBlock.id ? knownBlock.id : "";
  if (!blockId) {
    const kids = await fetchChildren(token, pageId, 2);
    const found = kids.find((b) => b && !b.archived && b.type === "code");
    if (found) blockId = found.id;
  }
  if (blockId) {
    await notionRequest(token, `/blocks/${blockId}`, "PATCH", { code: { rich_text: richTextChunks(json) } });
    return blockId;
  }
  /* 코드 블록이 지워졌으면 새로 하나 만든다 */
  const made = await notionRequest(token, `/blocks/${pageId}/children`, "PATCH", {
    children: [{ object: "block", type: "code", code: { language: "json", rich_text: richTextChunks(json) } }],
  });
  return (made.results && made.results[0] && made.results[0].id) || "";
}

function studyPageError(err) {
  return jsonResponse({
    ok: false,
    code: "notion_page",
    error: err && err.message ? err.message : "노션 페이지를 읽지 못했어요",
    hint: "노션에서 「🎮 은호 포켓몬·학습 상태」 페이지를 열고 우측 위 ⋯ → 연결 에서 family-notion 을 추가해 주세요",
  }, 502, { "Cache-Control": "no-store" });
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

        /* 📔 세줄일기 (비밀키 없으면 401) */
        if (url.pathname === "/diary" || url.pathname === "/diary/") {
          if (!diaryAuthorized(request, env)) return diaryUnauthorized();
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

        /* 🎮 학습·도감 상태 읽기 */
        if (url.pathname === "/study-state" || url.pathname === "/study-state/") {
          const pageId = studyPageId(env);
          let found;
          try {
            found = await readStudyState(env.NOTION_TOKEN, pageId);
          } catch (err) {
            return studyPageError(err);
          }
          const state = found.state;
          const savedAt = state ? Math.max(0, Math.round(numOr0(state.savedAt))) : 0;
          return jsonResponse({
            ok: true,
            savedAt: savedAt,
            pageId: pageId,
            state: savedAt > 0 ? state : null,
          }, 200, { "Cache-Control": "no-store" });
        }

        if (url.pathname === "/" || url.pathname === "/status") {
          return jsonResponse({
            ok: true,
            name: "family-notion",
            live: ["/book-reviews", "/mailbox", "/diary", "/diary?month=YYYY-MM", "/diary?meta=1", "/study-state"],
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

      /* 🎮 학습·도감 상태 저장 */
      if (url.pathname === "/study-state" || url.pathname === "/study-state/") {
        const incoming = (body.state && typeof body.state === "object" && !Array.isArray(body.state))
          ? body.state
          : ((body.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot)) ? body.snapshot : null);
        if (!incoming) {
          return jsonResponse({ ok: false, error: "state 가 필요해요" }, 400, { "Cache-Control": "no-store" });
        }
        const at = Math.max(0, Math.round(numOr0(incoming.savedAt) || numOr0(body.savedAt) || Date.now()));
        incoming.savedAt = at;
        if (JSON.stringify(incoming).length > 180000) {
          return jsonResponse({ ok: false, error: "상태가 너무 커서 저장하지 못했어요" }, 413, { "Cache-Control": "no-store" });
        }

        const pageId = studyPageId(env);
        let cur;
        try {
          cur = await readStudyState(env.NOTION_TOKEN, pageId);
        } catch (err) {
          return studyPageError(err);
        }
        const curState = cur.state;
        const curAt = curState ? Math.max(0, Math.round(numOr0(curState.savedAt))) : 0;

        /* ① 빈 기기(0/1025)는 기존 기록을 덮어쓰지 않는다 — 기록을 그대로 돌려준다 */
        if (curState && curAt > 0 && isBlankState(incoming) && !isBlankState(curState)) {
          return jsonResponse({ ok: true, skipped: "blank", savedAt: curAt, state: curState }, 200, { "Cache-Control": "no-store" });
        }

        /* ② 다른 기기가 더 최근에 저장했으면 받지 않고 최신 상태를 돌려준다 */
        const base = Math.max(0, Math.round(numOr0(body.base)));
        if (curAt > 0) {
          const stale = base > 0 ? curAt > base : curAt > at;
          if (stale) {
            return jsonResponse({ ok: true, conflict: true, savedAt: curAt, state: curState }, 200, { "Cache-Control": "no-store" });
          }
        }

        try {
          await writeStudyState(env.NOTION_TOKEN, pageId, incoming, cur.block);
        } catch (err) {
          return studyPageError(err);
        }
        return jsonResponse({ ok: true, savedAt: at, pageId: pageId, updatedAt: toIsoKst(Date.now()) }, 200, { "Cache-Control": "no-store" });
      }

      /* 📔 세줄일기 저장 / 수정 (비밀키 없으면 401) */
      if (url.pathname === "/diary" || url.pathname === "/diary/") {
        if (!diaryAuthorized(request, env)) return diaryUnauthorized();
        return await handleDiaryPost(env, body);
      }

      return jsonResponse({ ok: false, error: "Unknown route" }, 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
