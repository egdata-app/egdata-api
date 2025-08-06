import mongoose from "mongoose";

export interface IPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  topics: string[];
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new mongoose.Schema<IPushSubscription>({
  id: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: String,
    required: true,
    index: true,
  },
  endpoint: {
    type: String,
    required: true,
  },
  keys: {
    p256dh: {
      type: String,
      required: true,
    },
    auth: {
      type: String,
      required: true,
    },
  },
  topics: {
    type: [String],
    default: [],
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field on save
pushSubscriptionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Create compound index for efficient queries
pushSubscriptionSchema.index({ userId: 1, topics: 1 });
pushSubscriptionSchema.index({ topics: 1 });

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);