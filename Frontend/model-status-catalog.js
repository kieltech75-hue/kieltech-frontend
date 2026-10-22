(() => {
  const originalFetch = window.fetch.bind(window);
  const apiBase = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8000'
    : window.location.origin;
  const providerFor = (modelId) => {
    if (modelId.startsWith('kielmind')) return 'KielMind';
    if (modelId.startsWith('kiellens')) return 'KielLens';
    if (modelId.startsWith('kielforge')) return 'KielForge';
    return 'Managed';
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  window.fetch = async (input, options) => {
    const response = await originalFetch(input, options);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/health/models') || !response.ok) return response;

    const health = await response.clone().json().catch(() => null);
    if (!health || !Array.isArray(health.models)) return response;

    let catalogResponse;
    try {
      catalogResponse = await originalFetch(`${apiBase}/v1/models/catalog`, { cache: 'no-store' });
    } catch {
      return response;
    }
    if (!catalogResponse.ok) return response;
    const catalog = await catalogResponse.json().catch(() => ({}));
    if (!Array.isArray(catalog.models)) return response;

    const telemetry = new Map(health.models.map((model) => [model.id, model]));
    const models = catalog.models.map((entry) => {
      const id = String(entry.model_id || '');
      const provider = providerFor(id);
      const observed = telemetry.get(id);
      return {
        id,
        name: escapeHtml(entry.display_name || id),
        provider: observed?.provider || provider,
        icon: observed?.icon || provider.charAt(0),
        status: 'unknown',
        latency_ms: null,
        availability_7d: null,
        history: Array(42).fill('unknown'),
        ...observed,
        id,
        name: escapeHtml(entry.display_name || id)
      };
    });
    return new Response(JSON.stringify({ ...health, models, total: models.length }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
})();