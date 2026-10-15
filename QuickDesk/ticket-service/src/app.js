const express = require('express');
const morgan = require('morgan');
const ticketRoutes = require('./routes/tickets');

const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '20kb' }));

app.use('/tickets', ticketRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: Object.values(err.errors).map((e) => e.message) });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid value for ' + err.path });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
