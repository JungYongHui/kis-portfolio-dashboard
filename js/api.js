/**
 * GAS JSON API 클라이언트.
 *
 * 계약: docs/api-contract.md
 * - 모든 요청(GET 포함)에 token 필수. 없거나 틀리면 {ok:false, error:'unauthorized'}.
 * - 응답 공통 wrapper: {ok:true, data:...} | {ok:false, error:string}
 * - POST는 Content-Type을 text/plain 으로 고정한다(커스텀 헤더 추가 시 CORS preflight 유발).
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'apiToken';

  function gasUrl() {
    var cfg = global.DASHBOARD_CONFIG || {};
    if (!cfg.gasWebAppUrl) throw new Error('config.js 의 gasWebAppUrl 이 비어 있습니다.');
    return cfg.gasWebAppUrl;
  }

  /** localStorage 는 사파리 프라이빗 모드 등에서 throw 할 수 있으므로 항상 감싼다. */
  function getToken() {
    try {
      return global.localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function setToken(token) {
    try {
      global.localStorage.setItem(TOKEN_KEY, String(token || '').trim());
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearToken() {
    try {
      global.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* no-op */
    }
  }

  function hasToken() {
    return !!getToken();
  }

  function ApiError(message, code) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.code = code || null;
    return err;
  }

  function unwrap(json) {
    if (!json || typeof json !== 'object') throw ApiError('응답 형식이 올바르지 않습니다.', 'bad_response');
    if (!json.ok) throw ApiError(json.error || 'unknown_error', json.error);
    return json.data;
  }

  async function parseJson(res) {
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      // action 누락 시 GAS가 레거시 HTML UI를 서빙하므로 JSON 파싱이 깨질 수 있다.
      throw ApiError('JSON이 아닌 응답을 받았습니다(HTTP ' + res.status + ').', 'bad_response');
    }
  }

  /**
   * GET 요청. token 을 쿼리스트링에 자동 포함한다.
   * token 을 마지막에 넣어 params 가 실수로 덮어쓰지 못하게 한다.
   */
  async function apiGet(action, params) {
    var token = getToken();
    if (!token) throw ApiError('API 토큰이 없습니다.', 'no_token');
    var qs = new URLSearchParams(Object.assign({ action: action }, params || {}, { token: token }));
    var res = await fetch(gasUrl() + '?' + qs.toString(), { method: 'GET' });
    return unwrap(await parseJson(res));
  }

  /**
   * POST 요청. body 에 token 을 포함하고 Content-Type 은 text/plain 고정.
   * (1단계에서는 아직 호출부가 없지만, 계약대로 미리 맞춰 둔다.)
   */
  async function apiPost(action, payload) {
    var token = getToken();
    if (!token) throw ApiError('API 토큰이 없습니다.', 'no_token');
    var body = Object.assign({ action: action }, payload || {}, { token: token });
    var res = await fetch(gasUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    return unwrap(await parseJson(res));
  }

  /**
   * 최초 토큰 발급. API_TOKEN 이 비어 있을 때만 성공하며, 이미 발급됐으면
   * {ok:false, error:'already_initialized'} 가 온다. 토큰 없이 호출 가능한 유일한 action.
   */
  async function bootstrapToken() {
    var res = await fetch(gasUrl() + '?' + new URLSearchParams({ action: 'bootstrapToken' }).toString());
    var data = unwrap(await parseJson(res));
    return data && data.token;
  }

  global.API = {
    apiGet: apiGet,
    apiPost: apiPost,
    bootstrapToken: bootstrapToken,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    hasToken: hasToken
  };
})(window);
