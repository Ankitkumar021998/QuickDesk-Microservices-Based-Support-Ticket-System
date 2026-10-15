const mongoose = require('mongoose');

const { Schema } = mongoose;

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high'];

// User ids come from auth-service (PostgreSQL). We store a small snapshot (id + name)
// instead of a foreign key, because the two services own separate databases.
const userRef = new Schema({ id: { type: Number, required: true }, name: { type: String, required: true } }, { _id: false });

const commentSchema = new Schema(
  {
    authorId: { type: Number, required: true },
    authorName: { type: String, required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const historySchema = new Schema(
  {
    from: { type: String, enum: STATUSES, required: true },
    to: { type: String, enum: STATUSES, required: true },
    changedBy: { type: userRef, required: true },
  },
  { _id: false, timestamps: { createdAt: 'at', updatedAt: false } }
);

const ticketSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    status: { type: String, enum: STATUSES, default: 'open' },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    createdBy: { type: userRef, required: true },
    assignedTo: { type: userRef, default: null },
    comments: [commentSchema],
    statusHistory: [historySchema],
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Indexes that match the list/filter queries
ticketSchema.index({ 'createdBy.id': 1, createdAt: -1 });
ticketSchema.index({ 'assignedTo.id': 1, status: 1 });
ticketSchema.index({ status: 1, priority: 1 });

const Ticket = mongoose.model('Ticket', ticketSchema);
Ticket.STATUSES = STATUSES;
Ticket.PRIORITIES = PRIORITIES;

module.exports = Ticket;
