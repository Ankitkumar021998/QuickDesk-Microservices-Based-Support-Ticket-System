const express = require('express');
const Ticket = require('../models/Ticket');
const { authenticate, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const authClient = require('../services/authClient');

const { STATUSES, PRIORITIES } = Ticket;
const router = express.Router();

// Allowed status workflow
const TRANSITIONS = {
  open: ['in_progress', 'closed'],
  in_progress: ['resolved', 'open', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: ['open'],
};

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/health', (req, res) => res.json({ service: 'ticket-service', status: 'ok' }));

// Everything below needs a valid JWT
router.use(authenticate);

router.param('id', (req, res, next, id) => {
  if (!OBJECT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ticket id' });
  return next();
});

// ---- access rules ----------------------------------------------------------
// admin: everything | agent: tickets assigned to them (or created by them) | user: own tickets
const isCreator = (user, ticket) => ticket.createdBy.id === user.id;
const isAssignee = (user, ticket) => Boolean(ticket.assignedTo) && ticket.assignedTo.id === user.id;
const canAccess = (user, ticket) =>
  user.role === 'admin' || isCreator(user, ticket) || (user.role === 'agent' && isAssignee(user, ticket));

// Returns the ticket, or sends 404 and returns null. 404 (not 403) so that
// people cannot discover which ticket ids exist.
async function loadAccessible(req, res) {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket || !canAccess(req.user, ticket)) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  return ticket;
}

// ---- stats (admin) ---------------------------------------------------------
router.get('/stats', authorize('admin'), asyncHandler(async (req, res) => {
  const [byStatusRows, byPriorityRows, unassigned] = await Promise.all([
    Ticket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Ticket.aggregate([{ $group: { _id: '$priority', count: { $sum: 1 } } }]),
    Ticket.countDocuments({ assignedTo: null, status: { $ne: 'closed' } }),
  ]);
  const toMap = (keys, rows) => Object.fromEntries(keys.map((k) => [k, rows.find((r) => r._id === k)?.count || 0]));
  res.json({
    byStatus: toMap(STATUSES, byStatusRows),
    byPriority: toMap(PRIORITIES, byPriorityRows),
    unassignedOpen: unassigned,
  });
}));

// ---- create ----------------------------------------------------------------
router.post('/', asyncHandler(async (req, res) => {
  const { title, description, priority } = req.body || {};
  const errors = [];
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 150) errors.push('title must be 3-150 characters');
  if (typeof description !== 'string' || !description.trim() || description.length > 5000) errors.push('description is required (max 5000 characters)');
  if (priority !== undefined && !PRIORITIES.includes(priority)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const ticket = await Ticket.create({
    title,
    description,
    priority,
    createdBy: { id: req.user.id, name: req.user.name },
  });
  return res.status(201).json({ ticket });
}));

// ---- list + filter + search + pagination -----------------------------------
// GET /tickets?status=open,in_progress&priority=high&assignedTo=unassigned|<agentId>&q=login&page=1&limit=10&sort=-createdAt
router.get('/', asyncHandler(async (req, res) => {
  const { status, priority, assignedTo, q } = req.query;
  const conditions = [];

  // role-based scoping
  if (req.user.role === 'user') {
    conditions.push({ 'createdBy.id': req.user.id });
  } else if (req.user.role === 'agent') {
    conditions.push({ $or: [{ 'assignedTo.id': req.user.id }, { 'createdBy.id': req.user.id }] });
  }

  if (status) {
    const list = String(status).split(',');
    if (!list.every((s) => STATUSES.includes(s))) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    conditions.push({ status: { $in: list } });
  }
  if (priority) {
    const list = String(priority).split(',');
    if (!list.every((p) => PRIORITIES.includes(p))) return res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}` });
    conditions.push({ priority: { $in: list } });
  }
  if (assignedTo !== undefined) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can filter by assignee' });
    if (assignedTo === 'unassigned') {
      conditions.push({ assignedTo: null });
    } else if (Number.isInteger(Number(assignedTo)) && Number(assignedTo) > 0) {
      conditions.push({ 'assignedTo.id': Number(assignedTo) });
    } else {
      return res.status(400).json({ error: 'assignedTo must be "unassigned" or an agent id' });
    }
  }
  if (q) {
    const rx = new RegExp(escapeRegex(String(q).slice(0, 100)), 'i');
    conditions.push({ $or: [{ title: rx }, { description: rx }] });
  }

  const SORTS = ['createdAt', '-createdAt', 'updatedAt', '-updatedAt'];
  const sort = SORTS.includes(req.query.sort) ? req.query.sort : '-createdAt';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const filter = conditions.length ? { $and: conditions } : {};

  const [data, total] = await Promise.all([
    Ticket.find(filter).select('-comments').sort(sort).skip((page - 1) * limit).limit(limit),
    Ticket.countDocuments(filter),
  ]);
  res.json({ data, page, limit, total, totalPages: Math.ceil(total / limit) });
}));

// ---- read one --------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const ticket = await loadAccessible(req, res);
  if (ticket) res.json({ ticket });
}));

// ---- assign (admin) --------------------------------------------------------
// Body: { "agentId": 3 }  or  { "agentId": null } to unassign
router.patch('/:id/assign', authorize('admin'), asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const { agentId } = req.body || {};
  if (agentId === null) {
    ticket.assignedTo = null;
    await ticket.save();
    return res.json({ ticket });
  }
  if (!Number.isInteger(agentId) || agentId < 1) {
    return res.status(400).json({ error: 'agentId must be a positive integer (or null to unassign)' });
  }

  // service-to-service REST call: does this user exist and is it an agent?
  const agent = await authClient.getUser(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.role !== 'agent') return res.status(400).json({ error: 'That user is not an agent' });

  ticket.assignedTo = { id: agent.id, name: agent.name };
  await ticket.save();
  return res.json({ ticket });
}));

// ---- status ----------------------------------------------------------------
// Assigned agent / admin: any valid transition. Ticket owner: may only close or re-open.
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  const ticket = await loadAccessible(req, res);
  if (!ticket) return null;

  const isStaff = req.user.role === 'admin' || (req.user.role === 'agent' && isAssignee(req.user, ticket));
  if (!isStaff && !['closed', 'open'].includes(status)) {
    return res.status(403).json({ error: 'Only the assigned agent or an admin can set this status' });
  }
  if (ticket.status === status) return res.status(400).json({ error: `Ticket is already ${status}` });
  if (!TRANSITIONS[ticket.status].includes(status)) {
    return res.status(400).json({
      error: `Cannot move from ${ticket.status} to ${status}`,
      allowed: TRANSITIONS[ticket.status],
    });
  }

  ticket.statusHistory.push({ from: ticket.status, to: status, changedBy: { id: req.user.id, name: req.user.name } });
  ticket.status = status;
  await ticket.save();
  return res.json({ ticket });
}));

// ---- comments --------------------------------------------------------------
router.post('/:id/comments', asyncHandler(async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
    return res.status(400).json({ error: 'text is required (max 2000 characters)' });
  }
  const ticket = await loadAccessible(req, res);
  if (!ticket) return null;
  if (ticket.status === 'closed') return res.status(400).json({ error: 'Cannot comment on a closed ticket' });

  ticket.comments.push({ authorId: req.user.id, authorName: req.user.name, text });
  await ticket.save();
  return res.status(201).json({ ticket });
}));

module.exports = router;
