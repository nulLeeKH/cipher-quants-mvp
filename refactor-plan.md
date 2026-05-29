# API Refactor Plan

## 목적

`api/src/server.ts`에 집중된 endpoint 라우팅, HTTP 처리, RFQ 비즈니스 로직, 내부
상태 관리 책임을 단계적으로 분리한다. 목표는 기능 변경 없이 구조를 정리해
`/quote`, `/swap`, `/freshness`, `/tokens`, `/metrics`의 책임 경계를 명확히 하고
테스트 가능한 단위를 늘리는 것이다.

## 현재 판단

현재 구조에서 라우터 및 핸들러 구조를 분리하는 판단은 타당하다. 다만 모든
interface를 하나의 `interface.ts`로 모으는 방식은 지양한다. 타입은 “공통
여부”보다 “소유 책임” 기준으로 배치한다.

- HTTP request/response 계약 타입은 HTTP 계층 소유로 분리한다.
- 특정 pure module의 입력/출력 타입은 해당 모듈에 유지한다.
- `/quote`와 `/swap`이 공유하는 내부 상태 타입은 quote store/service 계층으로
  이동한다.
- `server.ts`는 최종적으로 bootstrap, dependency wiring, `Deno.serve`만 담당하게
  한다.

## 범위

대상 범위:

- `api/src/server.ts`
- `api/src/metrics.ts`
- `api/src/rate_limit.ts`
- `api/src/cache.ts`
- `api/src/quote_pricing.ts`
- 신규 HTTP/service/store 모듈
- 필요한 테스트 파일

비대상 범위:

- SDK public API 변경
- on-chain instruction/layout 변경
- endpoint response shape 변경
- 새 dependency 추가
- JupiterZ 호환 동작 변경

## 타입 배치 원칙

### 1. 만들지 않을 것: 전역 `interface.ts`

`api/src/interface.ts` 하나에 모든 타입을 모으지 않는다. 시간이 지나면 타입 덤프
파일이 되어 소유권이 흐려지고 순환 의존이 생기기 쉽다.

### 2. HTTP 계약 타입

HTTP endpoint request/response DTO는 HTTP 계층에 둔다.

추천 파일:

```txt
api/src/http/contracts.ts
```

이동 대상:

- `QuoteRequest`
- `QuoteResponse`
- `SwapRequest`
- `SwapResponse`

이 타입들은 외부 API 계약이므로 handler, test, 문서와 함께 변경되어야 한다.

### 3. 모듈 전용 타입

특정 pure helper의 입력/출력 타입은 기존 모듈에 유지한다.

예:

- `freshness.ts`
  - `FreshnessInput`
  - `Freshness`
  - `RecommendedPath`
- `quote_pricing.ts`
  - `QuotePricingInput`
  - `QuotePricing`
  - `Direction`
- `metrics.ts`
  - `Metrics`
- `rate_limit.ts`
  - `SlidingWindowRateLimiter*`

### 4. 내부 공유 상태 타입

`PendingQuote`는 `/quote`에서 생성하고 `/swap`에서 소비하는 내부 상태이므로
quote store 계층에 둔다.

추천 파일:

```txt
api/src/quote_store.ts
```

예상 타입:

```ts
export interface PendingQuote { ... }
export interface QuoteStore {
  set(pending: PendingQuote): void;
  get(quoteId: string): PendingQuote | undefined;
  delete(quoteId: string): void;
  stop(): void;
}
```

## 목표 구조

```txt
api/src/
  server.ts
  http/
    app.ts
    contracts.ts
    handlers/
      health.ts
      metrics.ts
      tokens.ts
      freshness.ts
      quote.ts
      swap.ts
    middleware/
      rate_limit.ts
  services/
    quote_service.ts
    swap_service.ts
  quote_store.ts
```

역할:

- `server.ts`
  - config 검증
  - quote signer 로드
  - Solana connection/provider/program 생성
  - dependencies 구성
  - `createApiApp(deps)` 호출
  - `Deno.serve` 시작/종료

- `http/app.ts`
  - Hono app 생성
  - middleware 등록
  - route 연결

- `http/handlers/*.ts`
  - request parsing
  - HTTP status/response 변환
  - metrics counter 갱신 중 HTTP 결과와 강하게 결합된 부분
  - service 호출

- `services/quote_service.ts`
  - pool state 조회
  - freshness 판단
  - quote pricing
  - inventory check
  - nonce/marker 생성
  - pending quote 저장

- `services/swap_service.ts`
  - pending quote 조회
  - user binding 검증
  - last-look 검증
  - price drift 검증
  - inventory recheck
  - signed quote 생성
  - execute swap ix 생성
  - tx assembly 호출
  - successful swap 후 quote consume

- `quote_store.ts`
  - pending quote TTL/LRU 저장소
  - cache cleanup lifecycle

## 단계별 실행 계획

### Phase 0 — 동작 고정 및 기준선 확인

목표: 리팩토링 전 현재 동작이 통과하는지 확인한다.

작업:

1. `api` 테스트 실행
   - `cd api && deno task test`
2. 타입 체크 실행
   - `cd api && deno task check`
3. 실패가 있으면 리팩토링 전에 원인 기록

완료 조건:

- 기존 테스트 결과가 확인됨
- 현재 실패가 있다면 리팩토링 원인과 구분되도록 문서화됨

### Phase 1 — 기존 분리 모듈 재사용으로 중복 제거

목표: 큰 구조 변경 전에 `server.ts` 내부 중복 구현을 기존 모듈로 교체한다.

작업:

1. `server.ts` 내부 metrics 구현 제거
   - `newMetrics`, `recordLatency`, `renderMetrics`를 `metrics.ts`에서 import
2. `server.ts` 내부 rate limit 구현 제거
   - `createSlidingWindowRateLimiter` 사용
   - HTTP client key 추출은 middleware 쪽으로 이동 가능
3. `server.ts` 내부 quote pricing 계산 제거
   - `computeQuotePricing` 사용
4. quote cache는 바로 일반 `cache.ts`로 치환할지, Phase 2의 `quote_store.ts`로
   감쌀지 결정
   - 선호: `quote_store.ts`를 만들고 내부에서 기존 `cache.ts` 재사용

검증:

- `cd api && deno task test`
- `cd api && deno task check`

완료 조건:

- endpoint 동작 변경 없이 `server.ts` 내 중복 helper 감소
- 기존 pure module 테스트 유지

### Phase 2 — HTTP 계약 타입 분리

목표: endpoint 외부 계약 타입을 HTTP 계층으로 이동한다.

작업:

1. `api/src/http/contracts.ts` 생성
2. 다음 타입 이동 및 export
   - `QuoteRequest`
   - `QuoteResponse`
   - `SwapRequest`
   - `SwapResponse`
3. `server.ts` 또는 handler에서 해당 타입 import

검증:

- `cd api && deno task check`
- `cd api && deno task test`

완료 조건:

- `server.ts`에서 HTTP DTO 선언 제거
- DTO 타입 소유권이 HTTP 계층으로 명확해짐

### Phase 3 — Quote store 분리

목표: `/quote`와 `/swap`이 공유하는 pending quote state를 명시적 store로 만든다.

작업:

1. `api/src/quote_store.ts` 생성
2. `PendingQuote` 이동
3. quote cache TTL/LRU 동작을 store API로 캡슐화
4. `server.ts`의 `quoteCache`, `cacheSet`, `cacheGet`, `cacheSweep` 제거
5. `stop()` lifecycle에서 `quoteStore.stop()` 호출

검증:

- quote store 단위 테스트 추가 또는 기존 cache 테스트로 충분한지 판단
- `cd api && deno task test`
- `cd api && deno task check`

완료 조건:

- pending quote state가 `server.ts`에서 제거됨
- `/quote`, `/swap` 공유 상태의 소유자가 명확해짐

### Phase 4 — Hono app 생성 분리

목표: `server.ts`에서 route 등록 책임을 분리한다.

작업:

1. `api/src/http/app.ts` 생성
2. `createApiApp(deps)` 정의
3. 기존 `const app = new Hono()` 및 route 등록을 `http/app.ts`로 이동
4. `server.ts`는 dependencies를 만들고 `createApiApp(deps)`만 호출

권장 deps 예시:

```ts
export interface ApiAppDeps {
  config: ApiConfig;
  connection: Connection;
  program: unknown;
  programId: PublicKey;
  quoteSigner: Keypair;
  metrics: Metrics;
  quoteStore: QuoteStore;
  sdk: unknown;
  sdkAccounts: unknown;
  sdkInstructions: unknown;
}
```

주의:

- 처음에는 `unknown`보다 기존 `any`를 유지해 diff를 작게 만들 수 있다.
- SDK 타입 정리는 별도 후속 작업으로 분리한다.

검증:

- 가능하면 `createApiApp` 대상으로 lightweight HTTP tests 추가
- `cd api && deno task check`
- `cd api && deno task test`

완료 조건:

- `server.ts`는 app route details를 모름
- route 등록 위치가 `http/app.ts`로 이동됨

### Phase 5 — Handler 분리

목표: endpoint별 HTTP 처리 코드를 파일 단위로 분리한다.

작업 순서:

1. 단순 endpoint 먼저 이동
   - `health.ts`
   - `tokens.ts`
   - `metrics.ts`
2. read-only endpoint 이동
   - `freshness.ts`
3. 복잡한 endpoint 이동
   - `quote.ts`
   - `swap.ts`

각 handler 책임:

- JSON body parse
- PublicKey/BigInt 등 HTTP 입력 변환
- service 호출
- status code와 response body 결정
- malformed request 처리

검증:

- 각 이동 후 `cd api && deno task check`
- 작은 단위로 `cd api && deno task test`

완료 조건:

- `server.ts`와 `http/app.ts`에 비즈니스 로직이 남지 않음
- handler 파일은 HTTP 계층 책임만 가짐

### Phase 6 — Quote service 분리

목표: `/quote`의 RFQ 생성 로직을 handler에서 분리한다.

작업:

1. `api/src/services/quote_service.ts` 생성
2. 다음 로직 이동
   - input/output mint direction 판단
   - pool state 조회
   - paused check
   - freshness check
   - `computeQuotePricing`
   - inventory check
   - expiry slot 계산
   - nonce 생성
   - quote nonce marker derivation
   - pending quote 저장
3. service 결과를 handler가 `QuoteResponse`로 변환하거나 service가 DTO-ready
   result 반환

선호:

- service는 HTTP status를 직접 알지 않는다.
- service는 domain result/error를 반환하고 handler가 HTTP status로 매핑한다.
- 단, 첫 리팩토링에서는 diff를 줄이기 위해 status 매핑을 완벽히 일반화하지
  않아도 된다.

검증:

- quote pricing 기존 tests 유지
- 가능하면 quote service dependency mock 테스트 추가
- `cd api && deno task check`
- `cd api && deno task test`

완료 조건:

- `/quote` handler가 짧아짐
- RFQ quote 생성 로직이 HTTP 없이 테스트 가능한 구조가 됨

### Phase 7 — Swap service 분리

목표: `/swap`의 last-look 및 tx 생성 로직을 handler에서 분리한다.

작업:

1. `api/src/services/swap_service.ts` 생성
2. 다음 로직 이동
   - pending quote 조회
   - userPubkey binding 검증
   - pool paused check
   - expiry check
   - freshness recheck
   - price drift check
   - inventory recheck
   - signed quote + verify ix 생성
   - vault/user ATA derivation
   - execute swap ix 생성
   - latest blockhash 조회
   - `assembleSwapTx` 호출
   - quote consume
3. handler는 request parsing과 result-to-response mapping만 담당

검증:

- `swap_tx.test.ts` 유지
- 가능하면 last-look pure helper를 별도 함수로 분리해 단위 테스트 추가
- `cd api && deno task check`
- `cd api && deno task test`

완료 조건:

- `/swap` handler가 짧아짐
- last-look 로직이 HTTP 계층과 분리됨

### Phase 8 — 정리 및 최종 검증

목표: 구조 변경 후 남은 냄새를 제거하고 품질 gate를 통과한다.

작업:

1. 불필요 import 제거
2. 중복 comments 정리
3. `server.ts` 최종 책임 확인
4. fallback-like code 검토
5. 문서/plan에 실제 변경 결과 체크 표시

검증:

- `cd api && deno task check`
- `cd api && deno task test`
- 가능하면 root-level 관련 test
  - `pnpm test:unit` 또는 최소 `(cd api && deno task test)`

완료 조건:

- 기존 endpoint contract 유지
- 테스트 통과
- `server.ts`가 bootstrap 중심으로 축소
- 타입 소유권이 명확함

## Fallback-like code 점검 계획

리팩토링 중 다음 패턴을 발견하면 별도 판단 후 처리한다.

검색 대상:

- `fallback`
- `temporary`
- `workaround`
- `bypass`
- `skip`
- `catch {}`
- silent default
- swallowed error

분류 기준:

- 오류를 숨기거나 검증을 우회하면 masking fallback slop으로 간주하고 제거 또는
  명시적 실패로 변경한다.
- 외부 SDK/RPC/환경 차이를 처리하기 위한 좁고 문서화된 호환 경로라면 유지하되
  테스트 또는 주석 근거를 남긴다.

## 테스트 전략

현재 존재하는 보호막:

- `cache.test.ts`
- `freshness.test.ts`
- `metrics.test.ts`
- `quote_pricing.test.ts`
- `rate_limit.test.ts`
- `swap_tx.test.ts`
- `config.test.ts`
- `nonce.test.ts`

추가 권장 테스트:

1. `api/tests/http/app.test.ts`
   - `/health` returns `ok`
   - `/tokens` response shape
   - `/metrics` disabled without token
   - `/metrics` unauthorized with wrong token
2. `api/tests/unit/quote_store.test.ts`
   - set/get
   - expired quote removal
   - max entry eviction
   - delete/consume
3. service-level tests
   - pure helper로 뽑을 수 있는 last-look drift calculation
   - quote result mapping

## 리스크와 대응

| 리스크                                        | 대응                                                |
| --------------------------------------------- | --------------------------------------------------- |
| 파일만 쪼개고 책임은 그대로 섞임              | handler와 service 책임을 명확히 구분                |
| 타입을 한 곳에 몰아 소유권 상실               | `contracts.ts`, module-local, store-local 원칙 유지 |
| SDK `any` 타입 정리까지 동시에 하며 diff 증가 | SDK typing 개선은 별도 후속 작업으로 분리           |
| endpoint response shape 변경                  | HTTP regression test 추가 후 이동                   |
| quote cache lifecycle 누락                    | `QuoteStore.stop()` 및 server handle stop 검증      |
| `/quote`와 `/swap` shared state 결합 약화     | `QuoteStore`를 명시 dependency로 주입               |

## 진행 체크리스트

- [x] Phase 0 — 기준선 테스트/체크 확인
- [x] Phase 1 — 기존 분리 모듈 재사용으로 중복 제거
- [x] Phase 2 — HTTP 계약 타입 분리
- [x] Phase 3 — Quote store 분리
- [x] Phase 4 — Hono app 생성 분리
- [x] Phase 5 — Handler 분리
- [x] Phase 6 — Quote service 분리
- [x] Phase 7 — Swap service 분리
- [x] Phase 8 — 정리 및 최종 검증

## 최종 완료 기준

- `server.ts`는 bootstrap/dependency wiring/server lifecycle 중심이다.
- endpoint별 HTTP handler가 분리되어 있다.
- `/quote`, `/swap` 핵심 비즈니스 로직은 service 계층에 있다.
- HTTP 계약 타입은 `http/contracts.ts`에 있다.
- module-local 타입은 각 모듈에 남아 있다.
- 전역 `interface.ts`는 만들지 않았다.
- api test/check가 통과한다.

## 실행 결과 메모

완료일: 2026-05-29

- `server.ts`는 bootstrap/dependency wiring/server lifecycle 중심으로
  축소되었다.
- HTTP route 등록은 `http/app.ts`로 이동했다.
- endpoint handler는 `http/handlers/*`로 분리했다.
- `/quote`, `/swap` 비즈니스 로직은 `services/quote_service.ts`,
  `services/swap_service.ts`로 이동했다.
- HTTP DTO는 `http/contracts.ts`로 이동했다.
- `PendingQuote`와 pending quote lifecycle은 `quote_store.ts`로 이동했다.
- 기존 `metrics.ts`, `rate_limit.ts`, `quote_pricing.ts`, `cache.ts`,
  `nonce.ts`를 재사용하도록 정리했다.
- `cache.ts`, `rate_limit.ts`의 timer handle 타입을
  `ReturnType<typeof setInterval>`로 정리했다. `server.ts`가 해당 모듈을
  import하면서 `deno check` 대상에 포함되어 드러난 타입 오류를 해결한 것이다.
- 테스트 파일은 `api/tests/{unit,http}`로 이동했다.
- 추가 테스트: `api/tests/http/app.test.ts`,
  `api/tests/unit/quote_store.test.ts`.

검증:

- `cd api && deno task check` — PASS
- `cd api && deno task test` — PASS, 57 passed (`api/tests/` 대상)
- `cd api && deno fmt --check src/server.ts src/cache.ts src/rate_limit.ts src/http src/services src/quote_store.ts src/quote_store.test.ts src/runtime.ts`
  — PASS
- `cd api && deno lint src/http/app.ts src/http/contracts.ts src/http/handlers src/http/middleware src/services src/quote_store.ts src/runtime.ts src/server.ts`
  — PASS
- `cd api && find src -name '*.ts' -print0 | xargs -0 deno check --unstable-sloppy-imports`
  — PASS

주의:

- SDK CommonJS require 결과는 기존과 동일하게 `any`로 유지했다. SDK 타입 강화는
  별도 리팩토링으로 분리하는 편이 안전하다.
- `/quote` 가격 계산은 기존 분리 모듈인 `computeQuotePricing`을 사용한다. 이
  모듈은 buy 방향에서 on-chain rounding 주석에 맞춰 ceil rounding을 사용한다.

## 후속 실행 결과 메모 — Narrow service deps

완료일: 2026-05-29

- `ApiRuntime`은 composition/app/handler wiring 계층에 남기고, service 함수는
  endpoint별 좁은 dependency object를 받도록 변경했다.
- `ResolvedApiConfig`를 추가해 server bootstrap에서 `baseMint`/`quoteMint`
  존재를 한 번 검증한 뒤 런타임 타입으로 보장한다.
- `quote_service.ts`는 `QuoteServiceDeps`를 받으며 더 이상 `ApiRuntime`에
  의존하지 않는다.
- `swap_service.ts`는 `SwapServiceDeps`를 받으며 더 이상 `ApiRuntime` 또는
  `Metrics`에 의존하지 않는다.
- swap metric 증가는 `swapHandler`의 `recordSwapMetric`으로 이동했다.
- `freshness_service.ts`를 추가해 `/freshness` handler도 필요한 dependency만
  선택해 넘기도록 정리했다.
- handler까지는 `ApiRuntime`을 허용하고, service 이하에는 narrow deps를 넘기는
  경계를 적용했다.

검증:

- `cd api && deno task check` — PASS
- `cd api && deno task test` — PASS, 57 passed
- `cd api && find src tests -name '*.ts' -print0 | xargs -0 deno check --unstable-sloppy-imports`
  — PASS
- `cd api && deno fmt --check deno.json tests src/server.ts src/cache.ts src/rate_limit.ts src/http src/services src/quote_store.ts src/runtime.ts`
  — PASS
- `cd api && deno lint tests src/http/app.ts src/http/contracts.ts src/http/handlers src/http/middleware src/services src/quote_store.ts src/runtime.ts src/server.ts`
  — PASS
