#!/usr/bin/env node
// End-to-end smoke test. Run against a running stack:
//   node scripts/smoke-test.js http://localhost:8080
// Needs Node 18+ (uses the built-in fetch). Reads ADMIN_EMAIL / ADMIN_PASSWORD from env.

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'admin@quickdesk.local',
  password: process.env.ADMIN_PASSWORD || 'Admin@12345',
};

let passed = 0;
function check(name, condition, details) {
  if (!condition) {
    console.error(`  FAIL  ${name}`, details !== undefined ? JSON.stringify(details) : '');
    process.exit(1);
  }
  passed += 1;
  console.log(`  ok    ${name}`);
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch (e) { /* no body */ }
  return { status: response.status, data };
}

async function registerAndLogin(name, email, password) {
  const reg = await api('POST', '/auth/register', { body: { name, email, password } });
  check(`register ${name}`, reg.status === 201, reg);
  const login = await api('POST', '/auth/login', { body: { email, password } });
  check(`login ${name}`, login.status === 200 && login.data.token, login);
  return { id: reg.data.user.id, token: login.data.token, email, password };
}

(async () => {
  const stamp = Date.now();
  console.log(`Smoke test against ${BASE}\n`);

  console.log('Health');
  check('gateway health', (await api('GET', '/health')).status === 200);
  check('auth-service health via gateway', (await api('GET', '/auth/health')).status === 200);
  check('ticket-service health via gateway', (await api('GET', '/tickets/health')).status === 200);
  check('/internal is not exposed by the gateway', (await api('GET', '/internal/users/1')).status === 404);

  console.log('\nAuth');
  const dup = await api('POST', '/auth/register', { body: { name: 'x', email: 'bad', password: '1' } });
  check('register validates input', dup.status === 400, dup);
  const admin = await api('POST', '/auth/login', { body: ADMIN });
  check('admin can log in', admin.status === 200 && admin.data.user.role === 'admin', admin);
  const adminToken = admin.data.token;

  const userA = await registerAndLogin('Alice User', `alice.${stamp}@test.dev`, 'Password@123');
  const userB = await registerAndLogin('Bob User', `bob.${stamp}@test.dev`, 'Password@123');
  const agentReg = await registerAndLogin('Asha Agent', `asha.${stamp}@test.dev`, 'Password@123');
  check('wrong password rejected', (await api('POST', '/auth/login', { body: { email: userA.email, password: 'nope-nope' } })).status === 401);
  check('/auth/me requires a token', (await api('GET', '/auth/me')).status === 401);
  check('normal user cannot list users', (await api('GET', '/auth/users', { token: userA.token })).status === 403);

  const promote = await api('PATCH', `/auth/users/${agentReg.id}/role`, { token: adminToken, body: { role: 'agent' } });
  check('admin promotes a user to agent', promote.status === 200 && promote.data.user.role === 'agent', promote);
  const agentLogin = await api('POST', '/auth/login', { body: { email: agentReg.email, password: agentReg.password } });
  const agentToken = agentLogin.data.token;
  check('agent token carries the agent role', agentLogin.data.user.role === 'agent');

  console.log('\nTickets');
  const bad = await api('POST', '/tickets', { token: userA.token, body: { title: 'x' } });
  check('create ticket validates input', bad.status === 400, bad);
  const created = await api('POST', '/tickets', {
    token: userA.token,
    body: { title: 'Cannot log in to portal', description: 'I get a blank page after login.', priority: 'high' },
  });
  check('user creates a ticket', created.status === 201 && created.data.ticket.status === 'open', created);
  const ticketId = created.data.ticket.id;

  const aList = await api('GET', '/tickets', { token: userA.token });
  check('owner sees own ticket', aList.status === 200 && aList.data.total === 1, aList);
  const bList = await api('GET', '/tickets', { token: userB.token });
  check('other user sees no tickets', bList.data.total === 0, bList);
  check("other user cannot open someone else's ticket", (await api('GET', `/tickets/${ticketId}`, { token: userB.token })).status === 404);
  check('invalid ticket id rejected', (await api('GET', '/tickets/123', { token: userA.token })).status === 400);

  check('user cannot assign tickets', (await api('PATCH', `/tickets/${ticketId}/assign`, { token: userA.token, body: { agentId: agentReg.id } })).status === 403);
  check('cannot assign to a non-agent', (await api('PATCH', `/tickets/${ticketId}/assign`, { token: adminToken, body: { agentId: userB.id } })).status === 400);
  const assigned = await api('PATCH', `/tickets/${ticketId}/assign`, { token: adminToken, body: { agentId: agentReg.id } });
  check('admin assigns ticket to agent (calls auth-service)', assigned.status === 200 && assigned.data.ticket.assignedTo.id === agentReg.id, assigned);

  const agentList = await api('GET', '/tickets', { token: agentToken });
  check('agent sees the assigned ticket', agentList.data.total === 1, agentList);

  console.log('\nStatus workflow');
  check('user cannot set in_progress', (await api('PATCH', `/tickets/${ticketId}/status`, { token: userA.token, body: { status: 'in_progress' } })).status === 403);
  const inProgress = await api('PATCH', `/tickets/${ticketId}/status`, { token: agentToken, body: { status: 'in_progress' } });
  check('agent: open -> in_progress', inProgress.status === 200 && inProgress.data.ticket.status === 'in_progress', inProgress);
  const invalid = await api('PATCH', `/tickets/${ticketId}/status`, { token: agentToken, body: { status: 'open' } });
  check('agent: in_progress -> open is allowed', invalid.status === 200, invalid);
  await api('PATCH', `/tickets/${ticketId}/status`, { token: agentToken, body: { status: 'in_progress' } });
  const resolved = await api('PATCH', `/tickets/${ticketId}/status`, { token: agentToken, body: { status: 'resolved' } });
  check('agent: in_progress -> resolved', resolved.status === 200 && resolved.data.ticket.statusHistory.length >= 3, resolved);
  const illegal = await api('PATCH', `/tickets/${ticketId}/status`, { token: agentToken, body: { status: 'open' } });
  check('illegal transition resolved -> open is rejected', illegal.status === 400 && Array.isArray(illegal.data.allowed), illegal);

  const comment = await api('POST', `/tickets/${ticketId}/comments`, { token: userA.token, body: { text: 'Thanks, that fixed it.' } });
  check('owner can comment', comment.status === 201 && comment.data.ticket.comments.length === 1, comment);
  const closed = await api('PATCH', `/tickets/${ticketId}/status`, { token: userA.token, body: { status: 'closed' } });
  check('owner can close own ticket', closed.status === 200 && closed.data.ticket.status === 'closed', closed);
  check('cannot comment on a closed ticket', (await api('POST', `/tickets/${ticketId}/comments`, { token: userA.token, body: { text: 'hello?' } })).status === 400);

  console.log('\nFilters & stats');
  await api('POST', '/tickets', { token: userA.token, body: { title: 'Printer is offline', description: 'Floor 2 printer', priority: 'low' } });
  const filtered = await api('GET', '/tickets?status=open&priority=low&q=printer', { token: userA.token });
  check('filter by status + priority + search', filtered.data.total === 1 && filtered.data.data[0].title === 'Printer is offline', filtered);
  const unassigned = await api('GET', '/tickets?assignedTo=unassigned', { token: adminToken });
  check('admin can list unassigned tickets', unassigned.status === 200 && unassigned.data.total >= 1, unassigned);
  const stats = await api('GET', '/tickets/stats', { token: adminToken });
  check('admin stats', stats.status === 200 && stats.data.byStatus.closed >= 1 && stats.data.byStatus.open >= 1, stats);
  check('user cannot read stats', (await api('GET', '/tickets/stats', { token: userA.token })).status === 403);

  console.log(`\nAll ${passed} checks passed.`);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
