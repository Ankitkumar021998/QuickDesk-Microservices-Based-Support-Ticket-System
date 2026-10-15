const express = require('express');
const morgan = require('morgan');
const authRoutes = require('./routes/auth');
const internalRoutes = require('./routes/internal');

const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.use('/auth', authRoutes);
app.use('/internal', internalRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
