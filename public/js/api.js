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

  updateProfile: (name, email) => request('PATCH', '/api/me', { name, email }),
  trackActivity: (body)      => request('POST', '/api/activity', body),
  captureState:  ()          => request('GET',  '/api/capture'),
  sendClicks:    (clicks)    => request('POST', '/api/clicks', { clicks }),
  notices:     ()            => request('GET',  '/api/notices'),
  notice:      (id)          => request('GET',  `/api/notices/${id}`),
  postComment: (id, body)    => request('POST', `/api/notices/${id}/comments`, { body }),

  /** Multipart, so it bypasses the JSON request helper. */
  async uploadProof(billId, blob) {
    const form = new FormData();
    form.append('image', blob, 'proof.jpg');
    const res = await fetch(`/api/bills/${billId}/proof`, {
      method: 'POST', credentials: 'same-origin', body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message);
    }
    return data;
  },

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

    proofs:        ()       => request('GET',  '/api/admin/proofs'),
    approveProof:  (id)     => request('POST', `/api/admin/proofs/${id}/approve`),
    rejectProof:   (id)     => request('POST', `/api/admin/proofs/${id}/reject`),
    markPaid:      (billId, note) =>
                               request('POST', `/api/admin/bills/${billId}/mark-paid`, { note }),
    waiveLateFee:  (billId)  => request('POST', `/api/admin/bills/${billId}/waive-late-fee`),
    setCommentHidden: (id, hidden) =>
                               request('POST', `/api/admin/comments/${id}/${hidden ? 'hide' : 'unhide'}`),
    runScheduled:  ()        => request('POST', '/api/admin/run-scheduled'),

    periods:       ()        => request('GET',  '/api/admin/periods'),
    addResident:   (body)    => request('POST', '/api/admin/residents', body),
    updateResident:(id, b)   => request('PATCH', `/api/admin/residents/${id}`, b),
    addNotice:     (body)    => request('POST', '/api/admin/notices', body),
    updateNotice:  (id, b)   => request('PATCH', `/api/admin/notices/${id}`, b),
    messages:      ()        => request('GET',  '/api/admin/messages'),
    markMessageHandled: (id) => request('POST', `/api/admin/messages/${id}/handled`),
    proofArchive:  (params = '') => request('GET', `/api/admin/proofs/archive${params}`),
    deleteProof:   (id)      => request('DELETE', `/api/admin/proofs/${id}`),
    updateBill:    (id, b)   => request('PATCH', `/api/admin/bills/${id}`, b),
    backupHealth:  ()        => request('GET',  '/api/admin/backup-health'),

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
    timeline:    (params = '') => request('GET', `/api/god/timeline${params}`),
    clicks:      (params = '') => request('GET', `/api/god/clicks${params}`),
    setCapture:  (on, hours)   => request('POST', '/api/god/capture', { on, hours }),
    handover:    (toOwnerId)   => request('POST', '/api/god/handover', { toOwnerId }),
  },
};

export { ApiError };
