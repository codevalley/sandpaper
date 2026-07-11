export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createSandpaperClient({ base, token, clientId, fetchImpl }) {
  const apiBase = String(base || '').replace(/\/+$/, '');
  const fetchRequest = fetchImpl || globalThis.fetch;

  const client = {
    async post(path, payload) {
      let response;
      try {
        response = await fetchRequest(`${apiBase}/${String(path).replace(/^\/+/, '')}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sandpaper-Token': token,
            'X-Sandpaper-Client': clientId,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new ApiError(error?.message || 'Sandpaper is unreachable', {
          status: 0,
          code: 'network_error',
        });
      }

      let value;
      try {
        value = await response.json();
      } catch {
        if (!response.ok) {
          throw new ApiError(`Sandpaper request failed (${response.status})`, {
            status: response.status,
            code: 'http_error',
          });
        }
        throw new ApiError('Sandpaper returned an invalid response', {
          status: response.status,
          code: 'invalid_response',
        });
      }

      if (!response.ok) {
        const serverError = value && value.ok === false && value.error;
        if (serverError && typeof serverError.code === 'string' && typeof serverError.message === 'string') {
          throw new ApiError(serverError.message, {
            status: response.status,
            code: serverError.code,
          });
        }
        throw new ApiError(`Sandpaper request failed (${response.status})`, {
          status: response.status,
          code: 'http_error',
        });
      }

      return value;
    },

    eventUrl() {
      return `${apiBase}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`;
    },
  };

  client.setDefaultProvider = (provider) => client.post('/provider-default', { provider });
  client.resetSession = ({ page, provider }) => client.post('/session/reset', { page, provider });
  return client;
}
