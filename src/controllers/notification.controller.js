'use strict';

const Notification = require('../models/Notification');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');

// --- GET /notifications -----------------------------------------------------

const listNotifications = asyncHandler(async (req, res) => {
  const { unreadOnly, page, limit } = req.query;
  const query = { customerId: req.customer._id };
  if (unreadOnly) query.readAt = null;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Notification.countDocuments(query),
    Notification.countDocuments({ customerId: req.customer._id, readAt: null }),
  ]);

  return ok(res, {
    items: items.map((n) => n.toPublicJSON()),
    page,
    limit,
    total,
    unreadCount,
    hasMore: page * limit < total,
  });
});

// --- GET /notifications/unread-count ----------------------------------------

/** Drives the badge on the home screen's bell icon. */
const getUnreadCount = asyncHandler(async (req, res) => {
  const unreadCount = await Notification.countDocuments({
    customerId: req.customer._id,
    readAt: null,
  });
  return ok(res, { unreadCount });
});

// --- POST /notifications/:notificationId/read -------------------------------

const markRead = asyncHandler(async (req, res) => {
  const { notificationId } = req.params;

  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, customerId: req.customer._id, readAt: null },
    { $set: { readAt: new Date() } },
    { new: true }
  );

  if (!notification) {
    // Either it does not exist, belongs to someone else, or was already read.
    // Treat "already read" as success so a double tap is not an error.
    const exists = await Notification.findOne({
      _id: notificationId,
      customerId: req.customer._id,
    });
    if (!exists) {
      throw ApiError.notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');
    }
    return ok(res, { notification: exists.toPublicJSON() }, 'Already read.');
  }

  return ok(res, { notification: notification.toPublicJSON() }, 'Marked as read.');
});

// --- POST /notifications/read-all -------------------------------------------

const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { customerId: req.customer._id, readAt: null },
    { $set: { readAt: new Date() } }
  );

  return ok(res, { markedCount: result.modifiedCount }, 'All notifications marked as read.');
});

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead };
