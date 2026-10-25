'use strict';

const mongoose = require('mongoose');

/**
 * Atomic sequence source for human-readable booking codes.
 * `findOneAndUpdate` with `$inc` is atomic in MongoDB, so two concurrent
 * bookings can never be handed the same number.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

counterSchema.statics.next = async function next(key, session) {
  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;
  const doc = await this.findByIdAndUpdate(key, { $inc: { seq: 1 } }, options);
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
