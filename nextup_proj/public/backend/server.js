// server.js - FIREBASE/FIRESTORE VERSION
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
// REMOVED: const { Server } = require('socket.io'); // Not needed for Firebase updates

// 1. Initialize Firebase Admin SDK
const admin = require('firebase-admin');
// NOTE: Rename your downloaded JSON key to this path.
const serviceAccount = require('./serviceAccountKey.json'); 

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Replace with your project ID
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com` 
});

const db = admin.firestore();
const app = express();
const httpServer = createServer(app);
const PORT = 3000;

// REMOVED: Socket.IO server initialization
// const io = new Server(httpServer, { ... });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, '..')));

// Service information (Keep this locally as it's static)
const serviceInfo = {
    cashier: { name: 'Cashier\'s Office', code: 'C' },
    registrar: { name: 'Registrar\'s Office', code: 'R' },
    guidance: { name: 'Guidance Office', code: 'G' },
    library: { name: 'Library', code: 'L' },
    clinic: { name: 'Clinic', code: 'CL' },
    it_office: { name: 'IT Office', code: 'IT' }
};

// --- CORE FIREBASE FUNCTIONS ---

// Function to get the next available queue number for a service
async function getNextQueueNumber(serviceId) {
    const configRef = db.collection('config').doc('queueNumbers');
    return db.runTransaction(async (transaction) => {
        const doc = await transaction.get(configRef);
        let nextNumber = 1;

        if (doc.exists && doc.data() && doc.data()[serviceId]) {
            nextNumber = doc.data()[serviceId] + 1;
        }

        // Increment the number for the next transaction
        transaction.set(configRef, { [serviceId]: nextNumber }, { merge: true });

        // Return the current number with the service code prefix
        const serviceCode = serviceInfo[serviceId].code;
        return `${serviceCode}${String(nextNumber).padStart(4, '0')}`;
    });
}

// Function to get the current queue state for a service
async function getQueueState(serviceId) {
    const queueRef = db.collection('queues').doc(serviceId);
    const doc = await queueRef.get();

    if (!doc.exists) {
        return {
            nowServing: null,
            waitingList: [],
            totalWaiting: 0,
            all: []
        };
    }

    const data = doc.data() || {};
    const all = data.list || [];
    
    const nowServing = all.find(q => q.status === 'serving') || null;
    const waitingList = all.filter(q => q.status === 'waiting');

    return {
        nowServing,
        waitingList: waitingList.sort((a, b) => a.timestamp - b.timestamp),
        totalWaiting: waitingList.length,
        all: all.sort((a, b) => a.timestamp - b.timestamp)
    };
}


// --- API ENDPOINTS ---

/**
 * POST /api/join-queue
 * Adds a new student/personnel to the queue.
 */
app.post('/api/join-queue', async (req, res) => {
    const { studentId, studentName, service } = req.body;

    if (!studentId || !studentName || !serviceInfo[service]) {
        return res.status(400).json({ message: 'Invalid request data.' });
    }
    
    try {
        const queueNumber = await getNextQueueNumber(service);
        const newQueueItem = {
            queueNumber,
            studentId,
            studentName,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: 'waiting' // waiting, serving, completed, cancelled
        };

        const queueRef = db.collection('queues').doc(service);
        
        // Use an array in a single document to maintain order and reduce writes
        await queueRef.set({
            list: admin.firestore.FieldValue.arrayUnion(newQueueItem)
        }, { merge: true });

        // FIX: The status document is for public reads (non-authenticated)
        await updatePublicStatus(service); 

        return res.status(200).json({ 
            message: `Successfully joined ${serviceInfo[service].name}.`,
            queueNumber: newQueueItem.queueNumber,
            yourPosition: (await getQueueState(service)).totalWaiting 
        });

    } catch (error) {
        console.error('Join queue error:', error);
        return res.status(500).json({ message: 'Server error while joining queue.' });
    }
});


/**
 * GET /api/queue-status/:service
 * Used by the client to poll for current status (now serving, total waiting).
 */
app.get('/api/queue-status/:service', async (req, res) => {
    const serviceId = req.params.service;
    if (!serviceInfo[serviceId]) {
        return res.status(404).json({ message: 'Service not found.' });
    }
    
    try {
        // FIX: Get the publicly readable status document
        const statusDoc = await db.collection('queueStatus').doc(serviceId).get();

        if (!statusDoc.exists) {
            return res.status(200).json({ 
                nowServing: null, 
                waitingList: [], 
                totalWaiting: 0 
            });
        }
        
        const data = statusDoc.data();
        // The waiting list is already pre-calculated by the server for efficiency
        return res.status(200).json(data); 

    } catch (error) {
        console.error('Queue status error:', error);
        res.status(500).json({ message: 'Server error retrieving queue status.' });
    }
});


/**
 * GET /api/dashboard
 * Used for the overall dashboard view.
 */
app.get('/api/dashboard', async (req, res) => {
    try {
        const stats = {
            totalWaiting: 0,
            totalServing: 0,
            services: []
        };
        
        const snapshot = await db.collection('queueStatus').get();
        snapshot.forEach(doc => {
            const data = doc.data();
            stats.totalWaiting += data.totalWaiting || 0;
            stats.totalServing += data.nowServing ? 1 : 0;
            
            stats.services.push({
                id: doc.id,
                name: serviceInfo[doc.id].name,
                queueLength: (data.totalWaiting || 0) + (data.nowServing ? 1 : 0),
                waiting: data.totalWaiting || 0,
                serving: data.nowServing || null
            });
        });

        res.json(stats);

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ message: 'Server error retrieving dashboard data.' });
    }
});


// --- ADMIN ENDPOINTS (CRUD) ---

/**
 * POST /api/admin/serve-next/:service
 * Moves the next waiting person to 'serving'.
 */
app.post('/api/admin/serve-next/:service', async (req, res) => {
    const serviceId = req.params.service;
    // ... [ADMIN AUTH LOGIC HERE - Omitted for simplicity/testing]

    try {
        const queueRef = db.collection('queues').doc(serviceId);
        
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(queueRef);
            if (!doc.exists) {
                throw new Error('Queue is empty.');
            }

            let all = doc.data().list || [];
            const isServing = all.some(q => q.status === 'serving');
            if (isServing) {
                throw new Error('Another client is already being served.');
            }

            const nextWaitingIndex = all.findIndex(q => q.status === 'waiting');

            if (nextWaitingIndex === -1) {
                throw new Error('No one is currently waiting.');
            }

            // Move next waiting person to serving
            all[nextWaitingIndex].status = 'serving';
            all[nextWaitingIndex].servingTime = admin.firestore.FieldValue.serverTimestamp();

            transaction.set(queueRef, { list: all }, { merge: false });
            
            // The transaction implicitly updates the queueStatus document
            await updatePublicStatus(serviceId);
            
            return all[nextWaitingIndex];
        });

        res.json({ message: `Successfully called next queue number for ${serviceInfo[serviceId].name}.` });
    } catch (error) {
        console.error('Serve next error:', error.message);
        res.status(400).json({ message: error.message });
    }
});


/**
 * POST /api/admin/complete-serving/:service
 * Moves the current 'serving' person to 'completed'.
 */
app.post('/api/admin/complete-serving/:service', async (req, res) => {
    const serviceId = req.params.service;
    // ... [ADMIN AUTH LOGIC HERE - Omitted for simplicity/testing]

    try {
        const queueRef = db.collection('queues').doc(serviceId);

        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(queueRef);
            if (!doc.exists) {
                throw new Error('Queue is empty.');
            }

            let all = doc.data().list || [];
            const servingIndex = all.findIndex(q => q.status === 'serving');

            if (servingIndex === -1) {
                throw new Error('No one is currently being served.');
            }

            // Move serving person to completed
            all[servingIndex].status = 'completed';
            all[servingIndex].completionTime = admin.firestore.FieldValue.serverTimestamp();

            transaction.set(queueRef, { list: all }, { merge: false });
            
            // Update the status document
            await updatePublicStatus(serviceId);
            
            return all[servingIndex];
        });

        res.json({ message: `Successfully completed serving for ${serviceInfo[serviceId].name}.` });
    } catch (error) {
        console.error('Complete serving error:', error.message);
        res.status(400).json({ message: error.message });
    }
});

/**
 * HELPER: Updates a public document with minimal read data for client polling.
 * This is a highly optimized read/write for the free tier.
 */
async function updatePublicStatus(serviceId) {
    const state = await getQueueState(serviceId);

    const publicList = state.waitingList.map(q => ({
        queueNumber: q.queueNumber,
        studentName: q.studentName,
        timestamp: q.timestamp 
    }));
    
    const publicServing = state.nowServing ? {
        queueNumber: state.nowServing.queueNumber,
        studentName: state.nowServing.studentName,
        servingTime: state.nowServing.servingTime
    } : null;

    const publicStatus = {
        nowServing: publicServing,
        waitingList: publicList.slice(0, 5), // Only keep first 5 for efficiency
        totalWaiting: state.totalWaiting,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('queueStatus').doc(serviceId).set(publicStatus);
}


// FIX: Serve HTML for all other routes - SIMPLIFIED
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
httpServer.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log('🔥 Firebase Admin SDK is active and connected to Firestore');
});