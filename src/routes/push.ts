import { Hono } from 'hono'
import { PushSubscription } from '../db/schemas/push-subscriptions.js';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { Context, Next } from 'hono';

type Variables = {
    user: ApiUser;
};

const app = new Hono<{ Variables: Variables }>();

// Types
interface SubscriptionBody {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}

interface TopicSubscriptionBody {
    subscriptionId: string;
    topics: string[];
}

interface ApiUser {
    id: string;
    apiKey: string;
}

interface NotificationPayload {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    data?: Record<string, unknown>;
    actions?: Array<{
        action: string;
        title: string;
        icon?: string;
    }>;
}

interface SendNotificationBody {
    topic: string;
    notification: NotificationPayload;
}

// Configure VAPID keys (should be set via environment variables)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_EMAIL) {
    const vapidEmail = process.env.VAPID_EMAIL.startsWith('mailto:')
        ? process.env.VAPID_EMAIL
        : `mailto:${process.env.VAPID_EMAIL}`;

    webpush.setVapidDetails(
        vapidEmail,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

// Validation functions
function validateSubscription(body: unknown): SubscriptionBody {
    const b = body as Record<string, unknown>;
    if (!b.endpoint || typeof b.endpoint !== 'string') {
        throw new Error('Invalid endpoint');
    }
    if (!b.keys || typeof b.keys !== 'object' || b.keys === null) {
        throw new Error('Invalid keys');
    }
    const keys = b.keys as Record<string, unknown>;
    if (!keys.p256dh || typeof keys.p256dh !== 'string') {
        throw new Error('Invalid p256dh key');
    }
    if (!keys.auth || typeof keys.auth !== 'string') {
        throw new Error('Invalid auth key');
    }
    return { endpoint: b.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function validateTopicSubscription(body: unknown): TopicSubscriptionBody {
    const b = body as Record<string, unknown>;
    if (!b.subscriptionId || typeof b.subscriptionId !== 'string') {
        throw new Error('Invalid subscriptionId');
    }
    if (!Array.isArray(b.topics)) {
        throw new Error('Invalid topics array');
    }
    return { subscriptionId: b.subscriptionId, topics: b.topics };
}

function validateSendNotification(body: unknown): SendNotificationBody {
    const b = body as Record<string, unknown>;
    if (!b.topic || typeof b.topic !== 'string') {
        throw new Error('Invalid topic');
    }
    if (!b.notification || typeof b.notification !== 'object' || b.notification === null) {
        throw new Error('Invalid notification');
    }
    const notification = b.notification as Record<string, unknown>;
    if (!notification.title || typeof notification.title !== 'string') {
        throw new Error('Invalid notification title');
    }
    if (!notification.body || typeof notification.body !== 'string') {
        throw new Error('Invalid notification body');
    }
    return {
        topic: b.topic,
        notification: {
            title: notification.title as string,
            body: notification.body as string,
            icon: notification.icon as string | undefined,
            badge: notification.badge as string | undefined,
            data: notification.data as Record<string, unknown> | undefined,
            actions: notification.actions as Array<{
                action: string;
                title: string;
                icon?: string;
            }> | undefined
        }
    };
}

// User API key authentication middleware
// Requires API key to be provided via X-API-Key header
// Each user gets their own unique API key for push notifications
const userApiKeyMiddleware = async (c: Context, next: Next) => {
    const apiKey = c.req.header('X-API-Key');

    if (!apiKey) {
        return c.json({ error: 'API key required' }, 401);
    }

    // For now, we'll use the API key as the user ID
    // In a real implementation, you'd validate against a database
    // and map the API key to a user ID
    const userId = apiKey; // Simple implementation - API key = user ID

    // Set user context
    c.set('user', { id: userId, apiKey });

    await next();
};

// Private key authentication middleware for admin operations
// Requires PUSH_ADMIN_API_KEY environment variable to be set
// API key can be provided via:
// - X-API-Key header
// - Authorization header (Bearer token or direct key)
const adminKeyMiddleware = async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    const apiKey = c.req.header('X-API-Key');

    // Check for API key in header or Authorization header
    const providedKey = apiKey || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);

    if (!providedKey) {
        return c.json({ error: 'API key required for this operation' }, 401);
    }

    // Check against environment variable
    const validApiKey = process.env.PUSH_ADMIN_API_KEY;
    if (!validApiKey) {
        return c.json({ error: 'Push notifications admin API not configured' }, 500);
    }

    if (providedKey !== validApiKey) {
        return c.json({ error: 'Invalid API key' }, 403);
    }

    await next();
};

// Subscribe to push notifications
app.post('/subscribe', userApiKeyMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { endpoint, keys } = validateSubscription(body);

        // Get user from API key middleware
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        // Check if subscription already exists for this user and endpoint
        const existingSubscription = await PushSubscription.findOne({
            userId,
            endpoint,
        });

        if (existingSubscription) {
            return c.json({
                id: existingSubscription.id,
                message: 'Subscription already exists',
            });
        }

        // Create new subscription
        const subscription = new PushSubscription({
            id: randomUUID(),
            userId,
            endpoint,
            keys,
            topics: [],
        });

        await subscription.save();

        return c.json({
            id: subscription.id,
            message: 'Successfully subscribed to push notifications',
        });
    } catch (error) {
        console.error('Error subscribing to push notifications:', error);
        return c.json({ error: 'Failed to subscribe' }, 500);
    }
});

// Check if the user is subscribed
app.get("/subscribe", userApiKeyMiddleware, async (c) => {
    try {
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        // Check if user has any active subscriptions
        const subscriptions = await PushSubscription.find({ userId }).select(
            'id endpoint topics createdAt updatedAt'
        );

        return c.json({
            isSubscribed: subscriptions.length > 0,
            subscriptionCount: subscriptions.length,
            subscriptions: subscriptions
        });
    } catch (error) {
        console.error('Error checking subscription status:', error);
        return c.json({ error: 'Failed to check subscription status' }, 500);
    }
})

// Unsubscribe from push notifications
app.delete('/unsubscribe/:subscriptionId', userApiKeyMiddleware, async (c) => {
    try {
        const subscriptionId = c.req.param('subscriptionId');
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        const result = await PushSubscription.deleteOne({
            id: subscriptionId,
            userId,
        });

        if (result.deletedCount === 0) {
            return c.json({ error: 'Subscription not found' }, 404);
        }

        return c.json({ message: 'Successfully unsubscribed' });
    } catch (error) {
        console.error('Error unsubscribing from push notifications:', error);
        return c.json({ error: 'Failed to unsubscribe' }, 500);
    }
});

// Subscribe to specific topics
app.post('/topics/subscribe', userApiKeyMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { subscriptionId, topics } = validateTopicSubscription(body);
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        const subscription = await PushSubscription.findOne({
            id: subscriptionId,
            userId,
        });

        if (!subscription) {
            return c.json({ error: 'Subscription not found' }, 404);
        }

        // Add new topics to existing ones (avoid duplicates)
        const uniqueTopics = [...new Set([...subscription.topics, ...topics])];
        subscription.topics = uniqueTopics;
        await subscription.save();

        return c.json({
            message: 'Successfully subscribed to topics',
            topics: subscription.topics,
        });
    } catch (error) {
        console.error('Error subscribing to topics:', error);
        return c.json({ error: 'Failed to subscribe to topics' }, 500);
    }
});

// Unsubscribe from specific topics
app.post('/topics/unsubscribe', userApiKeyMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { subscriptionId, topics } = validateTopicSubscription(body);
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        const subscription = await PushSubscription.findOne({
            id: subscriptionId,
            userId,
        });

        if (!subscription) {
            return c.json({ error: 'Subscription not found' }, 404);
        }

        // Remove topics from subscription
        subscription.topics = subscription.topics.filter(
            topic => !topics.includes(topic)
        );
        await subscription.save();

        return c.json({
            message: 'Successfully unsubscribed from topics',
            topics: subscription.topics,
        });
    } catch (error) {
        console.error('Error unsubscribing from topics:', error);
        return c.json({ error: 'Failed to unsubscribe from topics' }, 500);
    }
});

// Get user's subscriptions and topics
app.get('/subscriptions', userApiKeyMiddleware, async (c) => {
    try {
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        const subscriptions = await PushSubscription.find({ userId }).select(
            'id endpoint topics createdAt updatedAt'
        );

        return c.json({ subscriptions });
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        return c.json({ error: 'Failed to fetch subscriptions' }, 500);
    }
});

// Get subscription by ID
app.get('/subscriptions/:subscriptionId', userApiKeyMiddleware, async (c) => {
    try {
        const subscriptionId = c.req.param('subscriptionId');
        const user = c.get('user') as ApiUser;
        const userId = user.id;

        if (!userId) {
            return c.json({ error: 'User not authenticated' }, 401);
        }

        const subscription = await PushSubscription.findOne({
            id: subscriptionId,
            userId,
        }).select('id endpoint topics createdAt updatedAt');

        if (!subscription) {
            return c.json({ error: 'Subscription not found' }, 404);
        }

        return c.json({ subscription });
    } catch (error) {
        console.error('Error fetching subscription:', error);
        return c.json({ error: 'Failed to fetch subscription' }, 500);
    }
});

// Send notification to topic subscribers (Admin only - requires API key)
app.post('/send', adminKeyMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { topic, notification } = validateSendNotification(body);

        // Check if VAPID is configured
        if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
            return c.json({ error: 'Push notifications not configured' }, 500);
        }

        // Find all subscriptions for this topic
        const subscriptions = await PushSubscription.find({
            topics: topic
        });

        if (subscriptions.length === 0) {
            return c.json({
                message: 'No subscribers found for this topic',
                topic,
                subscriberCount: 0
            });
        }

        // Send notification to each subscription
        const results = await Promise.allSettled(
            subscriptions.map(async (sub) => {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.keys.p256dh,
                        auth: sub.keys.auth
                    }
                };

                try {
                    await webpush.sendNotification(
                        pushSubscription,
                        JSON.stringify(notification)
                    );
                    return { success: true, subscriptionId: sub.id };
                } catch (error: unknown) {
                    console.error(`Failed to send notification to ${sub.id}:`, error);

                    // Remove invalid subscriptions (410 = Gone)
                    const err = error as { statusCode?: number; message?: string };
                    if (err.statusCode === 410) {
                        await PushSubscription.deleteOne({ id: sub.id });
                        return { success: false, subscriptionId: sub.id, removed: true, error: 'Subscription expired' };
                    }

                    return { success: false, subscriptionId: sub.id, error: err.message || 'Unknown error' };
                }
            })
        );

        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const failed = results.filter(r => r.status === 'fulfilled' && !r.value.success).length;
        const removed = results.filter(r => r.status === 'fulfilled' && r.value.removed).length;

        return c.json({
            message: 'Notification sending completed',
            topic,
            totalSubscribers: subscriptions.length,
            successful,
            failed,
            removed,
            results: results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: 'Promise rejected' })
        });
    } catch (error) {
        console.error('Error sending notification:', error);
        return c.json({ error: 'Failed to send notification' }, 500);
    }
});

// Send notification to specific user (Admin only - requires API key)
app.post('/send-to-user', adminKeyMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const b = body as Record<string, unknown>;

        if (!b.userId || typeof b.userId !== 'string') {
            return c.json({ error: 'Invalid userId' }, 400);
        }
        if (!b.notification || typeof b.notification !== 'object') {
            return c.json({ error: 'Invalid notification' }, 400);
        }

        const userId = b.userId;
        const notification = b.notification as NotificationPayload;

        // Check if VAPID is configured
        if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
            return c.json({ error: 'Push notifications not configured' }, 500);
        }

        // Find all subscriptions for this user
        const subscriptions = await PushSubscription.find({ userId });

        if (subscriptions.length === 0) {
            return c.json({
                message: 'No subscriptions found for this user',
                userId,
                subscriberCount: 0
            });
        }

        // Send notification to each subscription
        const results = await Promise.allSettled(
            subscriptions.map(async (sub) => {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.keys.p256dh,
                        auth: sub.keys.auth
                    }
                };

                try {
                    await webpush.sendNotification(
                        pushSubscription,
                        JSON.stringify(notification)
                    );
                    return { success: true, subscriptionId: sub.id };
                } catch (error: unknown) {
                    console.error(`Failed to send notification to ${sub.id}:`, error);

                    // Remove invalid subscriptions (410 = Gone)
                    const err = error as { statusCode?: number; message?: string };
                    if (err.statusCode === 410) {
                        await PushSubscription.deleteOne({ id: sub.id });
                        return { success: false, subscriptionId: sub.id, removed: true, error: 'Subscription expired' };
                    }

                    return { success: false, subscriptionId: sub.id, error: err.message || 'Unknown error' };
                }
            })
        );

        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const failed = results.filter(r => r.status === 'fulfilled' && !r.value.success).length;
        const removed = results.filter(r => r.status === 'fulfilled' && r.value.removed).length;

        return c.json({
            message: 'Notification sending completed',
            userId,
            totalSubscriptions: subscriptions.length,
            successful,
            failed,
            removed,
            results: results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: 'Promise rejected' })
        });
    } catch (error) {
        console.error('Error sending notification to user:', error);
        return c.json({ error: 'Failed to send notification' }, 500);
    }
});

// Get VAPID public key for frontend
app.get('/vapid-public-key', async (c) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return c.json({ error: 'VAPID public key not configured' }, 500);
    }

    return c.json({
        publicKey: process.env.VAPID_PUBLIC_KEY
    });
});

// Get topic statistics
app.get('/topics/stats', userApiKeyMiddleware, async (c) => {
    try {
        const topicStats = await PushSubscription.aggregate([
            { $unwind: '$topics' },
            { $group: { _id: '$topics', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        return c.json({
            topics: topicStats.map(stat => ({
                topic: stat._id,
                subscriberCount: stat.count
            }))
        });
    } catch (error) {
        console.error('Error fetching topic statistics:', error);
        return c.json({ error: 'Failed to fetch topic statistics' }, 500);
    }
});

export default app;