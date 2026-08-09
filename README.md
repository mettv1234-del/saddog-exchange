# SADDOG Exchange (SOG/USDOG 모의투자)

## Vercel 배포 방법 (모바일에서 5분이면 끝)

### 방법 A — GitHub 없이 바로 배포 (가장 쉬움)
1. https://vercel.com 접속 → 회원가입/로그인 (구글 계정으로 가능)
2. 대시보드에서 **Add New → Project**
3. 화면에 나오는 업로드 영역에 이 폴더 전체(saddog-app)를 드래그해서 올리기
   - PC에서 하는 걸 추천 (모바일 브라우저는 폴더 업로드가 불편할 수 있음)
4. Framework Preset이 자동으로 **Vite**로 잡히는지 확인
5. **Deploy** 클릭 → 1~2분 후 `https://프로젝트명.vercel.app` 같은 URL 발급됨
6. 그 URL을 모바일 브라우저에 입력하면 바로 접속 가능 (홈 화면에 추가하면 앱처럼 사용 가능)

### 방법 B — GitHub 연동 (나중에 계속 수정할 계획이면 추천)
1. 이 폴더를 GitHub 저장소에 push
2. Vercel → Add New → Project → 해당 저장소 Import
3. 이후 코드를 고쳐서 push할 때마다 자동으로 재배포됨

## 로컬에서 미리 확인하고 싶다면 (PC, 선택사항)
```bash
npm install
npm run dev
```
브라우저에서 http://localhost:5173 접속

## 폴더 구조
- `src/App.jsx` — 게임 전체 로직/UI (여기를 수정하면 게임이 바뀜)
- `src/main.jsx` — React 진입점
- `index.html` — HTML 템플릿
- `tailwind.config.js` — 스타일 설정

## 현재 버전 기능
- SOG/USDOG 실시간(로컬 시뮬레이션) 차트: MA20/50(핑크)/200(흰색), 볼린저밴드, 일목균형표
- RSI(14)+Signal(20), 거래량 패널
- 차트 드래그로 과거 확인, 확대/축소, 개인 추세선 그리기
- 1~100배 레버리지, Cross/격리 모드 선택
- 청산 시 즉시 리필 버튼 (추후 광고 연동 예정)
- 구글 로그인은 UI만 구현 (실제 인증 없음 — 버튼 누르면 게스트 입장)

## 다음 단계 (미구현)
- 실제 구글 로그인 (OAuth) + 유저별 DB 저장
- 여러 유저가 동시에 같은 가격을 보는 실시간 멀티플레이 (Node.js + WebSocket + DB 필요)
- 광고 SDK 연동
