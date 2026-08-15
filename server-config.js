window.SERVER_CONFIG = {
  // Em produção, deixe vazio para usar o mesmo servidor das overlays.
  API_BASE_URL: '',
  // O servidor mantém o ciclo em 1 ms por padrão. O navegador/vMix e a origem
  // podem impor limites físicos; SSE é usado para entregar alterações imediatamente.
  UPDATE_INTERVAL_MS: 1,
  STREAM_ENDPOINT: '/api/stream'
};
