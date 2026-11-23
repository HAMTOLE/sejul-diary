# 📔 세줄일기 (sejul-diary)

은비 님 전용 개인 일기 웹앱입니다. 시안 B(깔끔한 모던 앱) 그대로 만들었고, 아이폰 홈 화면에 추가하면
앱처럼 전체 화면으로 열립니다. 일기는 노션 「📔 세줄일기」 데이터베이스에 저장되고, 앱은
Cloudflare Worker(`family-notion`)의 `/diary` 주소로 노션과 바로 연결됩니다.

## 들어 있는 파일

```
sejul-diary/
  index.html       앱 전체 (화면 + 기능, 외부 라이브러리 없음)
  manifest.json    홈 화면 앱 설정(standalone, 이름, 색)
  icon-192.png     홈 화면 아이콘 (apple-touch-icon)
  icon-512.png     앱 아이콘
  icon-32.png      파비콘
  data.json        노션에 연결되기 전 보여 줄 예시 기록 2편 (가상 인물·가상 일상, 사진 없음)
  worker-patch.js  Cloudflare Worker 전체 코드 (/diary · /study-state 추가판)
```

> ⚠️ **이 저장소는 공개(Public)입니다.** 세줄일기 비밀키는 이 저장소 어디에도 넣지 않습니다.
> 실제 키가 들어간 배포본은 노션 「⚙️ Worker 코드 최신판」 페이지에만 둡니다. 그래서 이 저장소의
> `worker-patch.js` 는 기본키가 비어 있고, 그대로 배포하면 `/diary` 는 잠긴 채로 열리지 않습니다.

## 1. 미리 보기 (내 컴퓨터에서)

```bash
cd sejul-diary
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

## 2. GitHub Pages (이미 배포됨)

- 주소: **https://hamtole.github.io/sejul-diary/**
- 저장소: `https://github.com/HAMTOLE/sejul-diary` (Public)
- 게시 브랜치: **`gh-pages`** (GitHub Pages 설정이 `gh-pages` / `(root)` 로 잡혀 있음)
  · `main` 은 작업 브랜치입니다. 고칠 때는 `main` 에 커밋한 뒤 **`gh-pages` 로도 밀어 줘야** 사이트가 바뀝니다.

```bash
git add -A && git commit -m "수정 내용"
git push origin main
git push origin main:gh-pages      # 이 줄이 있어야 실제 사이트에 반영
```

처음부터 다시 올릴 때: 저장소 **Settings → Pages → Source: Deploy from a branch → Branch: `main`(또는 `gh-pages`) / `(root)` → Save** → 1~2분 뒤 열립니다.

## 3. Cloudflare Worker 업데이트

기존 `family-notion` Worker 를 `worker-patch.js` 내용으로 **전체 교체**합니다.

1. Cloudflare 대시보드 → Workers & Pages → `family-notion` → Edit code
2. 기존 코드를 모두 지우고 `worker-patch.js` 를 붙여 넣기 → **Deploy**
3. Settings → Variables and Secrets 에서 확인
   - `NOTION_TOKEN` (기존 그대로, 필수)
   - `BOOK_DB_ID`, `MAILBOX_DB_ID`, `MEAL_DB_ID` (기존 그대로)
   - `DIARY_DB_ID` (선택, 없으면 `4208d929-53b6-8060-bd8a-d05eb1ad6363` 사용)
   - `DIARY_KEY` (선택 — 넣으면 코드의 기본키보다 우선. 나중에 키를 바꿀 때 씁니다)
4. 노션에서 「📔 세줄일기」 데이터베이스가 이 연동(Connection)에 공유돼 있어야 합니다.

### 🔐 세줄일기 비밀키 (`/diary` 잠금)

`/diary` (GET·POST)는 요청 헤더 `X-Diary-Key` 가 맞아야만 응답합니다. 없거나 틀리면
`401 { "error": "diary_auth_required" }` 를 돌려줍니다. 대시보드용 `/book-reviews` · `/mailbox` ·
`/study-state` · `/book-review` · `/meal-like` 는 예전처럼 키 없이 열려 있습니다.

- 키를 넣는 곳: Worker 코드의 `DIARY_KEY_FALLBACK` 기본값(코드만 덮어써도 바로 동작) 또는
  Cloudflare Variables 의 `DIARY_KEY`(있으면 이 값이 우선).
- 앱은 처음 한 번 키를 물어보고, 입력한 키를 브라우저 `localStorage`(`sejul.diaryKey`)에 저장해
  이후 모든 `/diary` 요청에 헤더로 실어 보냅니다. 설정(⚙️)에서 **비밀키 변경**·**이 기기에서 잠그기**를 할 수 있습니다.
- CORS preflight 를 위해 `Access-Control-Allow-Headers` 에 `Content-Type, X-Diary-Key` 가 들어 있습니다.

배포 뒤 확인 (키 부분은 실제 비밀키로 바꿔서):

```
https://family-notion.mynamebiya.workers.dev/status          → ok:true
https://family-notion.mynamebiya.workers.dev/diary?meta=1    → 401 (키 없이)
curl -s -H "X-Diary-Key: <비밀키>" "https://family-notion.mynamebiya.workers.dev/diary?meta=1"    → 일기 목록
curl -s -H "X-Diary-Key: <비밀키>" "https://family-notion.mynamebiya.workers.dev/diary?month=2026-11" → 그 달 일기 + 세 줄 + 사진
```

`/diary` 가 잠겨 있거나(비밀키 필요) 잠시 끊겨도 앱은 **비밀키 입력창 → 이 기기에 저장된 기록 → 예시 기록**
순서로 대응하고, 위쪽에 안내 배너를 띄웁니다. 배너의 `다시` 를 누르면 다시 연결을 시도합니다.

## 4. 아이폰 홈 화면에 추가

Safari 로 `https://hamtole.github.io/sejul-diary/` 를 연 뒤
**공유 버튼 → 홈 화면에 추가**. 이름은 "세줄일기"로 들어가고, 이후엔 주소창 없이 앱처럼 열립니다.

## 5. 노션과 어떻게 연결되나

| 앱 | 노션 「📔 세줄일기」 |
|---|---|
| 제목 | `제목` (title) |
| 날짜 | `날짜` (date) |
| 세 줄 | 페이지 **본문 문단** 3개 (한 줄 = 문단 하나) |
| 한줄 요약 | `한줄 요약` (rich_text) — 첫 줄을 자동으로 넣습니다 |
| 태그 | `함께` (multi_select) — `가족·은호·은비·호성` 처럼 |
| 분류 | `분류` (select) — 태그에 `일상·모임 / 학교·행사 / 체험·여행` 이 있으면 자동으로 맞춰 줌 |
| 사진 | 페이지 본문의 **이미지 블록** (노션 파일 업로드 API 사용) |

- 태그는 `함께` 칸을 그대로 씁니다. 처음 쓰는 태그(예: `뜨개`)는 노션 선택지에 자동으로 추가됩니다.
- 앱에서 본문을 불러올 때는 노션 페이지 본문의 문단과 이미지 블록을 읽어 옵니다.
  다른 곳(노션 앱)에서 쓴 일기도 본문이 문단으로 되어 있으면 그대로 보입니다.

## 6. 알아 둘 점

- **사진**은 저장할 때 1400px·JPEG(약 0.78 품질)로 줄여 올립니다. 사진 올리기가 실패해도 글은 저장되고
  "사진 1장은 노션에 올리지 못했어요" 로 알려 줍니다.
- **수정**할 때 본문 문단은 자리를 지킨 채 글자만 바뀌어 순서가 흐트러지지 않습니다. 사진은 ✕ 로 뺀 것만
  노션에서도 빠지고, 남긴 사진은 그대로 둡니다.
- 노션 사진 주소는 1시간쯤 지나면 만료됩니다. 앱을 열 때마다 새 주소를 받아 오므로 화면에는 문제가 없고,
  아주 오래 닫아 둔 뒤 오프라인으로 열면 사진이 잠시 비어 보일 수 있습니다.
- **삭제 기능은 아직 없습니다.** 지우려면 노션에서 직접 지우면 됩니다.
- 같은 제목·같은 날짜로 다시 저장하면(전송이 겹친 경우) 새로 만들지 않고 그 일기를 고칩니다.
- 앱 상단 `const API_BASE` 한 줄만 바꾸면 Worker 주소를 다른 곳으로 옮길 수 있습니다.

## 7. (선택) 잠금 비밀번호

앱을 열 때 4자리 비밀번호를 묻는 화면은 이미 들어 있고, 아래처럼 켤 수 있습니다.
(Safari 개발자 콘솔 또는 홈 화면 앱에서 실행)

```js
localStorage.setItem('sejul.pin', '1234');   // 켜기
localStorage.removeItem('sejul.pin');        // 끄기
```

※ 이 잠금은 이 기기의 화면만 가리는 장치입니다. 일기 내용 자체는 노션 계정과 Worker 비밀키(`X-Diary-Key`)로 보호됩니다.

## 8. 폰트

아이폰 기본 폰트(`-apple-system / Apple SD Gothic Neo`)를 먼저 쓰고, 없으면 Pretendard·Noto Sans KR 로
떨어집니다. 큰 폰트 파일을 내려받지 않아 첫 화면이 즉시 뜹니다.
Pretendard 를 꼭 쓰고 싶으면 부분집합(약 300KB)을 `assets/` 에 넣고 `@font-face` 로 앞에 추가하면 됩니다.
