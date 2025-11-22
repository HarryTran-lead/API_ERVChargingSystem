const admin = require('firebase-admin');

let messagingInstance = null;
let initializationAttempted = false;

const parseServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT', { error: error.message });
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  return null;
};

const initMessaging = () => {
  if (messagingInstance || initializationAttempted) {
    return messagingInstance;
  }

  initializationAttempted = true;
  const serviceAccount = parseServiceAccount();

  if (!serviceAccount) {
    // eslint-disable-next-line no-console
    console.warn('[firebase] Service account is not configured; push notifications disabled');
    return null;
  }

  try {
    const app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    messagingInstance = admin.messaging(app);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[firebase] Failed to initialize Firebase', { error: error.message });
    messagingInstance = null;
  }

  return messagingInstance;
};

const getMessaging = () => messagingInstance || initMessaging();

module.exports = {
  getMessaging,
};