/**
 * 배포 설정. 이 파일에는 비밀값을 절대 넣지 않는다.
 *
 * gasWebAppUrl 은 공개해도 안전하다 — GAS 쪽에서 모든 action(GET/POST)이
 * Script Properties 의 API_TOKEN 과 대조되므로, URL만으로는 아무 데이터도 조회되지 않는다.
 * (docs/api-contract.md "인증" 절 참조)
 *
 * API 토큰은 코드가 아니라 사용자의 브라우저 localStorage('apiToken')에만 저장된다.
 */
window.DASHBOARD_CONFIG = {
  gasWebAppUrl: 'https://script.google.com/macros/s/AKfycbxDei8LR3rrNqut6WLzlfYk8UfK7QAgJEZYt4z8CMXqvK24-zdU7R-oiJd698cKHNmZ/exec'
};
