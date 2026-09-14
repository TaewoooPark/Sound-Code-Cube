# Gallery and image provenance

[README로 돌아가기](../README.md)

README의 PNG는 이 프로젝트의 실제 Three.js/WebGL 렌더링을 캡처한 이미지입니다. 생성형 이미지 모델로 만든 큐브나 외부 작품의 사진을 사용하지 않았습니다. 공개 문서에는 개인 경로, 계정 화면, OAuth 정보가 들어간 캡처가 없습니다.

| 파일 | 장면과 범위 |
| --- | --- |
| [`sound-code-cube.png`](images/sound-code-cube.png) | 실제 앱의 1440 × 900 재생 화면. 반투명 큐브와 타이핑되는 TidalCycles 코드, 좌측 재생·초기화 및 우측 색상 컨트롤이 함께 보입니다. |
| [`pressure-volume.png`](images/pressure-volume.png) | 실제 `WaveCube` 렌더러의 독립 검증 장면. 여덟 소스에 제어된 펄스를 입력하여 압력장 부피를 표시합니다. |
| [`genre-transition.png`](images/genre-transition.png) | 같은 렌더러에서 회전·던지기와 색조 전환을 확인한 장면. 오디오 녹음이나 두 곡의 동시 재생을 이미지로 증명하는 자료는 아닙니다. |
| [`custom-colormap.png`](images/custom-colormap.png) | 정지된 압력장에 사용자 색 구간과 색조를 적용한 렌더러 검증 장면. |
| [`mobile-volume.png`](images/mobile-volume.png) | 390 × 844 뷰포트에서의 볼륨 렌더링. 반응형 시각화 검증이며 휴대폰 독립 실행이나 원격 네트워크 접속을 뜻하지 않습니다. |
| [`three-areas.svg`](images/three-areas.svg) | 코드·소리·공간의 관계를 설명하는 원본 벡터 다이어그램. 사인 곡선과 큐브 아이콘은 개념을 설명하는 도형입니다. |
| [`eight-layers.svg`](images/eight-layers.svg) | 두 사이클마다 레이어가 추가되는 시간을 설명하는 원본 벡터 다이어그램. |

PNG는 캡처 원본을 그대로 보관했습니다. SVG에는 외부 폰트, 원격 이미지, 스크립트가 없으며 접근성을 위한 제목과 설명을 포함합니다. 참고 논문·예술 작품의 이미지와 샘플 오디오를 README 자산으로 재배포하지 않습니다.

## TidalCycles 자료

[짧은 예시](../examples/eight-voices.tidal)는 읽기 쉽도록 사람이 정리한 코드입니다. [Drum and bass](../examples/drum-and-bass.tidal)와 [Dub](../examples/dub.tidal)는 실제 Codex가 만든 구조화된 악보를 프로젝트의 Tidal 렌더러로 변환한 저장본입니다. 모든 예시의 패턴은 GHCi와 Tidal로 파싱하고 두 사이클의 이벤트를 평가해 확인했습니다. 악보는 원본이며 외부 곡의 전사본이 아닙니다.

이 파일들은 악보만 담습니다. 실제 소리를 내려면 본인의 TidalCycles·SuperDirt 실행 환경, Dirt-Samples, 프로젝트의 신스 정의가 필요합니다.
