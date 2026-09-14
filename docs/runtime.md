# Local runtime

[설치 안내로 돌아가기](../README.md#설치-및-실행)

모든 공개 실행 경로에는 **사용자의 컴퓨터에 설치된 Codex CLI와 본인 ChatGPT OAuth 로그인**이 필요합니다. 진단과 로그인은 터미널에서 진행합니다.

## 명령

| 명령 | 역할 |
| --- | --- |
| `npm run doctor` | 설치된 Codex, 필요한 CLI 기능, ChatGPT OAuth 상태 확인 |
| `npm run login` | 설치된 Codex CLI로 본인 ChatGPT 로그인 실행 |
| `npm run setup:samples` | Dirt-Samples를 `.runtime/`에 별도 다운로드 |
| `npm run setup:native` | macOS/Homebrew에서 Tidal·SuperCollider·SuperDirt 환경 준비 |
| `npm run build` | TypeScript 확인과 브라우저 빌드 |
| `npm start` | 빌드된 앱 + 브라우저 합성 + 로컬 API, 포트 4318 |
| `npm run start:native` | 빌드된 앱 + 실제 Tidal/SuperDirt, 포트 4318 |
| `npm run dev` | Vite 개발 서버 + 브라우저 합성 + 로컬 API, 화면 포트 5173 |
| `npm run dev:native` | Vite 개발 서버 + 실제 Tidal/SuperDirt, 화면 포트 5173 |
| `npm test` | 회귀 테스트 |

`npm start`와 `npm run start:native` 전에 `npm run build`가 필요합니다. `preview`는 프런트엔드 미리보기이므로 작곡 API까지 시작하는 공개 실행 명령으로 사용하지 않습니다. 이미 다른 실행 모드가 켜져 있다면 해당 터미널에서 Ctrl+C로 종료한 뒤 전환합니다.

## Codex 탐지와 자신의 계정 사용

로컬 서버는 PATH, 명시한 `CODEX_BIN`, 지원하는 데스크톱 앱의 내장 CLI에서 실행 파일을 탐색하고 버전·기능과 `codex login status` 결과를 검사합니다. 이 앱은 ChatGPT OAuth 세션을 요구하며 API 키 로그인만으로 준비 완료로 처리하지 않습니다. 설치되지 않음, 로그인 필요, API 키 로그인, 호환되지 않는 CLI, 확인 시간 초과를 구분해 터미널에서 해결 방법을 안내합니다.

Codex 설치 방법은 [공식 CLI 문서](https://developers.openai.com/codex/cli/), 계정 로그인은 [공식 인증 문서](https://developers.openai.com/codex/auth/)를 참고하세요. 보통 아래와 같이 준비할 수 있습니다.

```sh
npm install -g @openai/codex
npm run login
npm run doctor
```

Codex를 다른 위치에 설치한 경우 `CODEX_BIN`에 실행 파일을 지정합니다. 이 앱은 자격 증명 파일을 읽어서 복사하거나 브라우저로 보내지 않습니다. CLI가 자신이 관리하는 인증으로 실행됩니다. 공개 저장소와 릴리스에는 작성자의 로그인 정보, Codex 기록, 로컬 `.runtime/` 파일이 포함되지 않습니다.

## 악보 생성과 안전한 실행

Codex는 장르 프로필과 앞선 악보의 구조를 받아 여덟 레이어의 음표 이벤트를 JSON으로 생성합니다. 서버가 범위·악기·박자를 검증하고 프로젝트가 소유한 Tidal 렌더러로 코드를 만듭니다. 모델이 돌려준 임의 Haskell을 그대로 평가하는 구조가 아닙니다.

앱은 처음 생성된 여덟 성부를 버퍼에 넣고 0·2·4·6·8·10·12·14 사이클에 추가합니다. 재생 중에는 현재 악보를 문맥으로 다음 장르를 준비합니다. 준비가 끝나기 전에 던지면 현재 음악을 계속 연주하다가 새 악보가 준비될 때 전환합니다. 정지는 이 대기 요청도 취소합니다.

Codex 오류를 임의의 로컬 작곡으로 숨기지 않습니다. 실제 원인과 상태는 실행 터미널, 브라우저 개발자 콘솔, 다음 진단에서 확인할 수 있습니다.

```js
window.soundCodeCube.snapshot()
```

스냅샷은 현재 장르, BPM, 조성, 레이어, 에셋, 생성 출처, 네이티브 상태, 재생·준비·전환 상태를 포함합니다. 계정 자격 증명을 포함하지 않습니다.

## 네이티브 오디오

네이티브 경로에는 GHC/GHCi의 Tidal 패키지, SuperCollider, SuperDirt, Vowel, Dirt-Samples가 필요합니다. `setup:native`의 자동 설치 경로는 macOS/Homebrew에서 검증했습니다. GHC 9.6.7과 Tidal 1.10.3으로 부팅과 제공된 예시 악보를 검증했습니다. Linux·WSL의 네이티브 경로는 필요한 구성 요소를 직접 설치한 뒤 아래 환경변수로 지정해야 합니다.

독립적인 두 Tidal 시계가 각자의 BPM으로 두 오디오 덱을 연주합니다. 덱마다 여덟 SuperDirt 오빗을 사용하고, 수동 타격은 별도의 열일곱 번째 오빗을 사용합니다. 전환은 두 덱의 음량을 equal-power 곡선으로 교차시킵니다. 두 장르의 템포를 같은 값으로 강제하는 비트 매칭은 아닙니다.

정지는 Codex 요청과 자식 프로세스, 아직 시작하지 않은 준비, 네이티브 예약음, 모든 오빗과 타격 잔향, 믹싱 타이머를 취소합니다. 세션 ID·요청 버전·서버의 소유권 확인으로 오래된 시작·전환 요청을 거부합니다. 새로고침은 다음 장르를 선택하되 사용자가 재생을 다시 누를 때까지 대기합니다.

브라우저와 네이티브 오디오가 같은 악보와 예약 시작 시각을 사용하지만 장치 버퍼까지 포함한 샘플 단위 동기화는 아닙니다. 시각화용 브라우저 신스와 네이티브 신스는 음색의 구현도 다릅니다. 브라우저 분석 신호는 SuperCollider 출력의 직접 녹음이 아닙니다.

## 환경변수

| 변수 | 용도 |
| --- | --- |
| `CODEX_BIN` | Codex 실행 파일 |
| `CODEX_MODEL` | 자신의 Codex에서 지원하는 모델 지정; 생략하면 CLI 기본 설정 사용 |
| `CODEX_TIMEOUT_MS` | 작곡 요청 제한시간; 기본 120,000ms |
| `TIDAL_ENABLED` | 수동 서버 실행에서 네이티브 Tidal 브리지 사용 |
| `GHCI_BIN` | GHCi 실행 파일 |
| `GHC_ENVIRONMENT` | Tidal 패키지가 설치된 GHC 환경 파일 |
| `TIDAL_BOOT_FILE` | 프로젝트와 호환되는 사용자 Tidal 부팅 파일 |
| `SCLANG_BIN` | SuperCollider 언어 실행 파일 |
| `SCC_SAMPLE_PATH` | SuperDirt 샘플 경로 패턴 |
| `SCC_BRIDGE_PORT` | 로컬 API 포트; 기본 4318 |

`.env` 파일은 자동으로 읽지 않습니다. 셸의 환경변수로 지정합니다. 커스텀 Tidal·SuperDirt 부팅은 이 앱의 시계와 정지·믹싱 프로토콜을 구현해야 합니다. 자세한 계약은 [서버 문서](../server/README.md)를 참고하세요. 기본 서버는 loopback에서만 사용하며, 원격 공개 서버로 호스팅하는 구성은 제공하지 않습니다.

## MIDI와 키보드

브라우저의 개발자 콘솔에서 다음 함수를 실행하면 Web MIDI 권한을 요청하고 연결된 출력으로 멜로디 음표를 함께 보낼 수 있습니다.

```js
await window.soundCodeCube.requestMidi()
```

브라우저의 Web MIDI 지원과 사용자의 장치 권한이 필요합니다. 기본 소리는 브라우저 또는 네이티브 신스로 이미 연주됩니다. 공간 회전이 MIDI 채널이나 외부 장치의 패닝을 자동으로 바꾸지는 않습니다.

Space는 재생·정지, Tab은 컨트롤 이동, 방향키는 색 범위 조절, Escape는 설정 닫기입니다. 화면의 설명 문구 대신 접근성 이름을 제공합니다.
