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

/**
 * Multipart, which the JSON helper above cannot express: setting a
 * content-type by hand would strip the boundary FormData generates and the
 * server would parse nothing.
 */
async function upload(path, field, blob, filename, thumb = null) {
  let res;
  try {
    const form = new FormData();
    form.append(field, blob, filename);
    if (thumb) form.append('thumb', thumb, 'thumb.jpg');
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
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
  login:   (mobile, password, remember = true) =>
             request('POST', '/api/login', { mobile, password, remember }),
  logout:  ()               => request('POST', '/api/logout'),
  me:      ()               => request('GET',  '/api/me'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/password', { currentPassword, newPassword }),

  /** Records that the resident opened their UPI app. NOT proof of payment. */
  payIntent: (billId) => request('POST', `/api/bills/${billId}/intent`),

  onboard:       (body)      => request('POST', '/api/onboard', body),
  updateProfile: (name, email) => request('PATCH', '/api/me', { name, email }),
  forgot: (mobile) => request('POST', '/api/forgot', { mobile }),
  reset:  (mobile, code, password) => request('POST', '/api/reset', { mobile, code, password }),
  trackActivity: (body)      => request('POST', '/api/activity', body),
  captureState:  ()          => request('GET',  '/api/capture'),
  sendClicks:    (clicks)    => request('POST', '/api/clicks', { clicks }),
  notices:     ()            => request('GET',  '/api/notices'),
  notice:      (id)          => request('GET',  `/api/notices/${id}`),
  postComment: (id, body)    => request('POST', `/api/notices/${id}/comments`, { body }),

  /**
   * One file per request, to whichever parent it belongs.
   *
   * The caller posts the notice or comment first and attaches afterwards, so
   * an upload that fails leaves a post that exists and a file that can simply
   * be tried again — rather than a half-written notice nobody can see.
   */
  attach(parent, id, file, thumb = null) {
    const path = parent === 'notice'
      ? `/api/admin/notices/${id}/attachments`
      : `/api/comments/${id}/attachments`;
    // The thumbnail rides along in the same request. Sending it separately
    // would leave a window where the board has a full-size image to render and
    // an upload that may still fail — two requests to get one attachment right.
    return upload(path, 'file', file, file.name, thumb);
  },

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
    /** The Home board's whole payload — see adminSummary in the Worker. */
    summary:       ()       => request('GET',  '/api/admin/summary'),
    /** Chase one overdue bill. The cap is enforced server-side, not here. */
    remind:        (billId)  => request('POST', `/api/admin/bills/${billId}/remind`),
    remindAll:     (period)  => request('POST', '/api/admin/reminders/bulk', { period }),
    // `past: true` includes moved-out residents and is superadmin-only —
    // the server refuses it for an admin rather than quietly dropping it.
    residents: (opts)       => request('GET',
                               `/api/admin/residents${opts?.past ? '?include=past' : ''}`),
    resetPassword: (id)     => request('POST', `/api/admin/residents/${id}/reset`),
    // The password goes back so the server can check it is still the current one
    // before mailing it — see emailTempPassword.
    emailTempPassword: (id, oneTimePassword) =>
                               request('POST', `/api/admin/residents/${id}/reset/email`,
                                       { oneTimePassword }),

    // B22: an admin asks, the superadmin approves, and approving applies it.
    requestContactChange: (id, body) =>
                               request('POST', `/api/admin/residents/${id}/contact-request`, body),
    contactRequests: ()     => request('GET',  '/api/admin/contact-requests'),
    decideContactRequest: (id, approve) =>
                               request('POST',
                                 `/api/admin/contact-requests/${id}/${approve ? 'approve' : 'reject'}`),

    // `period` here is always the USAGE month, never the month being walked.
    readings:      (period) => request('GET',  `/api/admin/readings?period=${period}`),
    saveReadings:  (period, readings) =>
                               request('PUT',  `/api/admin/readings?period=${period}`, { readings }),
    parseReadings: (text)   => request('POST', '/api/admin/readings/parse', { text }),
    /** Every flat, billed or not — includes the ones nobody has bought. */
    flats:         ()       => request('GET',  '/api/admin/flats'),
    /** Take a flat out of billing, or put it back. A reason is required. */
    setFlatActive: (flat, active, reason) =>
                               request('PATCH', `/api/admin/flats/${encodeURIComponent(flat)}`,
                                       { active, reason }),
    preview:       (period) => request('GET',  `/api/admin/preview?period=${period}`),
    openPeriod:    (body)   => request('POST', '/api/admin/periods', body),
    /** dryRun first, always: the caveat is built from what it returns. */
    changeRate:    (period, ratePerKg, reason, dryRun = false) =>
                               request('PATCH', `/api/admin/periods/${period}`,
                                       { ratePerKg, reason, dryRun }),
    generate:      (period) => request('POST', `/api/admin/periods/${period}/generate`),

    proofs:        ()       => request('GET',  '/api/admin/proofs'),
    approveProof:  (id)     => request('POST', `/api/admin/proofs/${id}/approve`),
    rejectProof:   (id)     => request('POST', `/api/admin/proofs/${id}/reject`),
    markPaid:      (billId, note) =>
                               request('POST', `/api/admin/bills/${billId}/mark-paid`, { note }),

    // These five belong to admins, NOT to god: the superadmin who raises a bill
    // edit must not be able to approve it, so approving lives here. They were
    // written inside the `god` object by mistake, which broke them twice over —
    // api.admin.bills and friends were undefined, and `bills`/`editBill` became
    // duplicate keys inside god, silently pointing god's own screens at these
    // admin routes. Keep them in this object.
    bills:       (params = '') => request('GET', `/api/admin/bills${params}`),
    editBill:    (id, field, value, reason) =>
                   request('PATCH', `/api/admin/bill/${id}`, { field, value, reason }),
    billEdits:   ()   => request('GET',  '/api/admin/bill-edits'),
    approveEdit: (id) => request('POST', `/api/admin/bill-edits/${id}/approve`),
    rejectEdit:  (id) => request('POST', `/api/admin/bill-edits/${id}/reject`),
    waiveLateFee:  (billId)  => request('POST', `/api/admin/bills/${billId}/waive-late-fee`),
    lateFees:      ()        => request('GET',  '/api/admin/late-fees'),
    setExemption:  (id, until, reason) =>
                     request('POST', `/api/admin/residents/${id}/late-fee-exemption`, { until, reason }),
    bulkExemption: (flats, until, reason, dryRun = false) =>
                     request('POST', '/api/admin/late-fee-exemption/bulk',
                             { flats, until, reason, dryRun }),
    setCommentHidden: (id, hidden) =>
                               request('POST', `/api/admin/comments/${id}/${hidden ? 'hide' : 'unhide'}`),
    runScheduled:  ()        => request('POST', '/api/admin/run-scheduled'),

    periods:       ()        => request('GET',  '/api/admin/periods'),
    addResident:   (body)    => request('POST', '/api/admin/residents', body),
    updateResident:(id, b)   => request('PATCH', `/api/admin/residents/${id}`, b),
    rosterPreview: (text)    => request('POST', '/api/admin/roster/preview', { text }),
    rosterImport:  (text)    => request('POST', '/api/admin/roster/import', { text }),
    rosterStatus:  ()        => request('GET',  '/api/admin/roster/status'),
    rosterMarkSent:(id)      => request('POST', `/api/admin/roster/sent/${id}`),
    addNotice:     (body)    => request('POST', '/api/admin/notices', body),
    deleteAttachment: (id)   => request('DELETE', `/api/admin/attachments/${id}`),
    noticeArchive: ()        => request('GET',  '/api/admin/notices/archive'),
    archivedNotice: (id)     => request('GET',  `/api/admin/notices/${id}/archived`),
    updateNotice:  (id, b)   => request('PATCH', `/api/admin/notices/${id}`, b),
    messages:      ()        => request('GET',  '/api/admin/messages'),
    markMessageHandled: (id) => request('POST', `/api/admin/messages/${id}/handled`),
    proofArchive:  (params = '') => request('GET', `/api/admin/proofs/archive${params}`),

    /**
     * Bank statement reconciliation. Multipart, so it bypasses the JSON helper.
     * The file is parsed server-side and never stored; only its credit rows are
     * held, and only until `finishStatement` or the nightly sweep.
     */
    async uploadStatement(file) {
      const form = new FormData();
      form.append('statement', file, file.name || 'statement.csv');
      const res = await fetch('/api/admin/statement', {
        method: 'POST', credentials: 'same-origin', body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = data?.error ?? {};
        throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message);
      }
      return data;
    },
    statementReport:  (id) => request('GET',    `/api/admin/statement/${id}`),
    finishStatement:  (id) => request('POST',   `/api/admin/statement/${id}/finish`),
    discardStatement: (id) => request('DELETE', `/api/admin/statement/${id}`),
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
    residents:   ()            => request('GET',  '/api/god/residents'),
    people:      ()            => request('GET',  '/api/god/people'),
    /** Destroys a withdrawn notice, its replies and its files. No undo. */
    purgeNotice: (id)          => request('DELETE', `/api/god/notices/${id}`),
    bills:       (params = '') => request('GET',  `/api/god/bills${params}`),
    edits:       (params = '') => request('GET',  `/api/god/edits${params}`),
    diagnostics: (params = '') => request('GET',  `/api/god/diagnostics${params}`),
    stats:       (days = 14)   => request('GET',  `/api/god/stats?days=${days}`),
    editOwner:   (id, field, value, reason) =>
                   request('PATCH', `/api/god/owner/${id}`, { field, value, reason }),
    editBill:    (id, field, value, reason) =>
                   request('PATCH', `/api/god/bill/${id}`, { field, value, reason }),
    /** A replaced meter. Backdated on purpose — the swap is reported late. */
    meterChanges:  (period)  => request('GET', `/api/god/meter-changes?period=${encodeURIComponent(period)}`),
    setMeterChange: (body)   => request('POST', '/api/god/meter-change', body),
    clearMeterChange: (flat, period) =>
                   request('DELETE', '/api/god/meter-change', { flat, period }),
  },
};

export { ApiError };
