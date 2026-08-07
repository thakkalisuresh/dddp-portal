/**
 * Thin fetch wrapper. Deliberately not a client library.
 *
 * Note what is absent: no identity is ever sent. There is no `flat` or
 * `ownerId` parameter on any resident call — the server derives the subject
 * from the session cookie. If you find yourself wanting to add one, the
 * endpoint belongs under /api/admin/ instead (plan §4b).
 */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Something went wrong.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'No connection. Check your network and try again.');
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message);
  }
  return data;
}

export const api = {
  health:  ()               => request('GET',  '/api/health'),
  login:   (mobile, password) => request('POST', '/api/login', { mobile, password }),
  logout:  ()               => request('POST', '/api/logout'),
  me:      ()               => request('GET',  '/api/me'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/password', { currentPassword, newPassword }),

  /** Records that the resident opened their UPI app. NOT proof of payment. */
  payIntent: (billId) => request('POST', `/api/bills/${billId}/intent`),

  admin: {
    residents: ()           => request('GET',  '/api/admin/residents'),
    resetPassword: (id)     => request('POST', `/api/admin/residents/${id}/reset`),

    // `period` here is always the USAGE month, never the month being walked.
    readings:      (period) => request('GET',  `/api/admin/readings?period=${period}`),
    saveReadings:  (period, readings) =>
                               request('PUT',  `/api/admin/readings?period=${period}`, { readings }),
    parseReadings: (text)   => request('POST', '/api/admin/readings/parse', { text }),
    preview:       (period) => request('GET',  `/api/admin/preview?period=${period}`),
    openPeriod:    (body)   => request('POST', '/api/admin/periods', body),
    generate:      (period) => request('POST', `/api/admin/periods/${period}/generate`),

    /** Hand out the template first so column order is guaranteed on the way back. */
    downloadTemplate(period, grid) {
      const rows = [['flat', 'floor', 'previous', 'reading']];
      for (const f of grid.flats) rows.push([f.flat, f.floor, f.previous ?? '', '']);
      const csv = rows.map((r) => r.join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `diamond-park-readings-${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  },

  god: {
    viewAs:      (flat)     => request('GET',  `/api/god/view-as/${encodeURIComponent(flat)}`),
    impersonate: (id, write = false) => request('POST', `/api/god/impersonate/${id}`, { write }),
    exit:        ()         => request('POST', '/api/god/exit'),
    errors:      ()         => request('GET',  '/api/god/errors'),
  },
};

export { ApiError };
