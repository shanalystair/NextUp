// public/queue.js - Firebase Client SDK Version (Spark Plan Compatible)

// --- Firebase Initialization ---
// !!! IMPORTANT: The API Key below is for "nextup-88c61". Ensure it is correct.
const firebaseConfig = {
    // Replaced placeholders with your project's details based on console logs:
    apiKey: "AIzaSyDNuFnE-K85NBrOrIISzLSq9ie4OhnmCuw", 
    authDomain: "nextup-88c61.firebaseapp.com",
    projectId: "nextup-88c61", 
    // The rest are optional for this setup and removed for simplicity
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// --- Anonymous Authentication (for basic user identification in Security Rules) ---
let currentUserUid = null;
auth.signInAnonymously()
    .then((userCredential) => {
        currentUserUid = userCredential.user.uid;
        console.log("Signed in anonymously with UID:", currentUserUid);
    })
    .catch((error) => {
        console.error("Error signing in anonymously:", error);
        showNotification("Failed to authenticate. Some features may not work. Check console for details.", true);
    });


// --- Helper Functions and UI Elements ---
const servicesListDiv = document.getElementById('services-list');
const queueStatusContentDiv = document.getElementById('queue-status-content');
const adminServiceSelect = document.getElementById('adminServiceSelect');
const adminCodeInput = document.getElementById('adminCodeInput');

// This serviceInfo can be dynamic from Firestore too, but for simplicity, kept client-side.
const serviceInfo = {
    cashier: { name: 'Cashier', description: 'Payment transactions', estimatedTime: 5 },
    registrar: { name: 'Registrar', description: 'Academic records', estimatedTime: 15 },
    guidance: { name: 'Guidance Office', description: 'Counseling services', estimatedTime: 20 },
    library: { name: 'Library', description: 'Book services', estimatedTime: 10 },
    clinic: { name: 'Clinic', description: 'Medical services', estimatedTime: 15 },
    it_office: { name: 'IT Office', description: 'Technical support', estimatedTime: 15 }
};

function showNotification(message, isError = false) {
    const notification = document.createElement('div');
    notification.className = `queue-notification ${isError ? 'error' : ''}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add('hiding');
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

// --- Dynamic Service Loading ---
async function loadServices() {
    servicesListDiv.innerHTML = '';
    adminServiceSelect.innerHTML = ''; // Clear admin select options

    for (const serviceId in serviceInfo) {
        const service = serviceInfo[serviceId];
        
        // Add to main services list
        const serviceCard = document.createElement('div');
        serviceCard.className = 'service-card';
        serviceCard.innerHTML = `
            <h3>${service.name}</h3>
            <p>${service.description}</p>
            <p>Est. Time: ${service.estimatedTime} mins</p>
            <button onclick="window.location.href='queue-page.html?serviceId=${serviceId}'">Join Queue</button>
            <button onclick="displayQueueStatus('${serviceId}')">View Status</button>
        `;
        servicesListDiv.appendChild(serviceCard);

        // Add to admin service select
        const option = document.createElement('option');
        option.value = serviceId;
        option.textContent = service.name;
        adminServiceSelect.appendChild(option);
    }
}

// --- Queue Joining Function ---
async function joinQueue(service) {
    if (!currentUserUid) {
        showNotification("Please wait for anonymous authentication to complete.", true);
        return;
    }

    const studentId = prompt("Enter your Student ID:");
    if (!studentId) {
        showNotification("❌ Student ID is required", true);
        return;
    }
    
    const studentName = prompt("Enter your Name:");
    if (!studentName) {
        showNotification("❌ Name is required", true);
        return;
    }

    try {
        // FIX: Changed path to match existing DB structure: 'queues'
        const serviceDocRef = db.collection('queues').doc(service);
        
        // Use a Firestore transaction to atomically get nextQueueNumber and add entry
        const result = await db.runTransaction(async (transaction) => {
            const serviceDoc = await transaction.get(serviceDocRef);

            let currentNextQueueNumber = 1;
            if (serviceDoc.exists) {
                currentNextQueueNumber = serviceDoc.data().nextQueueNumber || 1;
            } else {
                // If service doc doesn't exist, we can't proceed as non-admins can't create it.
                // An admin needs to pre-create service docs.
                // FIX: Update error message to suggest the correct next step.
                throw new Error(`Service '${service}' is not initialized. An admin must set the initial 'nextQueueNumber' in the /queues/${service} document.`);
            }

            const queueNumber = `${service.toUpperCase().substring(0, 3)}${currentNextQueueNumber.toString().padStart(3, '0')}`;

            // --- FIX: REMOVED FLAWED POSITION/WAIT CALCULATION ---
            // The true position is calculated by the real-time listener after the document is committed.

            const queueEntry = {
                queueNumber,
                studentId,
                studentName,
                service,
                // Removed position & estimatedWait here.
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                status: 'waiting',
                userUid: currentUserUid // Store the user's UID for security rules to validate creation
            };

            // FIX: Changed path to match existing DB structure: 'waitingList'
            const newEntryRef = serviceDocRef.collection('waitingList').doc(); 
            transaction.set(newEntryRef, queueEntry);

            // Increment nextQueueNumber in the service document
            transaction.update(serviceDocRef, {
                nextQueueNumber: currentNextQueueNumber + 1
            });

            return { queueNumber, serviceName: serviceInfo[service].name };
        });

        // Redirect the user to the queue-page now that they have a ticket
        window.location.href = `queue-page.html?serviceId=${service}&joinedDocId=TBD`;
        // TBD: The queue-page.html must be updated to handle the new `queueNumber` format.
        
    } catch (error) {
        console.error('❌ Error joining queue:', error);
        showNotification(`❌ Failed to join queue: ${error.message}`, true);
    }
}

// --- Real-time Queue Status Display ---
let unsubscribeQueueStatus = null; // To store the unsubscribe function for listeners

function displayQueueStatus(serviceId) {
    if (unsubscribeQueueStatus) {
        unsubscribeQueueStatus(); // Detach previous listener if active
    }
    
    queueStatusContentDiv.innerHTML = `<p>Loading queue status for ${serviceInfo[serviceId].name}...</p>`;

    // FIX: Changed path to match existing DB structure: 'queues' and 'waitingList'
    const serviceDocRef = db.collection('queues').doc(serviceId);
    const entriesCollectionRef = serviceDocRef.collection('waitingList');

    // Listen to changes in the active entries subcollection
    unsubscribeQueueStatus = entriesCollectionRef
        .where('status', 'in', ['waiting', 'serving']) // Only show waiting/serving
        .orderBy('timestamp', 'asc') // REQUIRES A COMPOSITE INDEX (See instructions below)
        .onSnapshot(async (snapshot) => {
            // Also fetch the latest service metadata to ensure display is current
            const serviceDoc = await serviceDocRef.get();

            let serviceName = serviceInfo[serviceId].name;
            let estimatedTimePerPerson = serviceInfo[serviceId].estimatedTime;

            if (serviceDoc.exists) {
                const serviceData = serviceDoc.data();
                serviceName = serviceData.name || serviceName;
                estimatedTimePerPerson = serviceData.estimatedTime || estimatedTimePerPerson;
            }

            const queueEntries = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const currentServing = queueEntries.find(q => q.status === 'serving');
            const waiting = queueEntries.filter(q => q.status === 'waiting');
            
            let statusMessage = `<h3>📊 ${serviceName} Queue</h3>`;
            statusMessage += `<p>Total Waiting: ${waiting.length}</p>`;
            statusMessage += `<p>Wait per person: ${estimatedTimePerPerson} min</p>`;
            
            if (currentServing) {
                statusMessage += `<p>▶️ <b>Serving:</b> ${currentServing.queueNumber} - ${currentServing.studentName}</p>`;
            } else {
                statusMessage += `<p>▶️ <b>Serving:</b> No one</p>`;
            }
            
            if (waiting && waiting.length > 0) {
                statusMessage += `<p>⏳ <b>Next in Line:</b></p><ul>`;
                // Show top 5 waiting customers for brevity
                waiting.slice(0, 5).forEach((entry, index) => {
                    statusMessage += `<li>${index + 1}. ${entry.queueNumber} - ${entry.studentName}</li>`;
                });
                statusMessage += `</ul>`;
            } else {
                statusMessage += `<p>⏳ No one waiting</p>`;
            }
            
            queueStatusContentDiv.innerHTML = statusMessage;

        }, (error) => {
            console.error("Error listening to queue status:", error);
            showNotification(`❌ Error loading queue status: ${error.message}`, true);
            queueStatusContentDiv.innerHTML = `<p class="error">Error loading queue status.</p>`;
        });
}

// --- Admin Functions (Client-side - INSECURE for production without server-side validation) ---

const ADMIN_CODE = "ADMIN123"; // This is a client-side "secret" and easily discoverable. DO NOT use in production.

// Function to check if the current user is an admin (based on Firestore 'admins' collection)
async function checkAdminPermissions() {
    if (!currentUserUid) {
        showNotification("Please wait for authentication to complete.", true);
        return false;
    }
    // Client-side check for a "password" - for demo only.
    if (adminCodeInput.value !== ADMIN_CODE) {
        return false;
    }
    
    try {
        const adminDoc = await db.collection('admins').doc(currentUserUid).get();
        return adminDoc.exists && adminDoc.data().isAdmin === true;
    } catch (error) {
        console.error("Error checking admin status:", error);
        return false;
    }
}

async function adminServeNext() {
    if (!(await checkAdminPermissions())) {
        showNotification("❌ Unauthorized: Invalid Admin Code or not an Admin.", true);
        return;
    }

    const service = adminServiceSelect.value;
    if (!serviceInfo[service]) {
        showNotification('Invalid service selected.', true);
        return;
    }

    try {
        const nextToServeData = await db.runTransaction(async (transaction) => {
            // FIX: Changed path to match existing DB structure: 'queues' and 'waitingList'
            const serviceDocRef = db.collection('queues').doc(service);
            const entriesCollectionRef = serviceDocRef.collection('waitingList');

            // Find the first waiting customer
            const waitingQuery = entriesCollectionRef
                .where('status', '==', 'waiting')
                .orderBy('timestamp', 'asc')
                .limit(1);
            const waitingSnapshot = await transaction.get(waitingQuery);

            if (waitingSnapshot.empty) {
                throw new Error('No one in queue to serve.');
            }

            const nextToServeDoc = waitingSnapshot.docs[0];
            const nextToServe = nextToServeDoc.data();

            // Check if someone is already being served for this service
            const servingQuery = entriesCollectionRef
                .where('status', '==', 'serving')
                .limit(1);
            const servingSnapshot = await transaction.get(servingQuery);

            if (!servingSnapshot.empty) {
                throw new Error('Someone is already being served for this service. Please complete them first.');
            }

            // Update status to 'serving'
            transaction.update(nextToServeDoc.ref, {
                status: 'serving',
                servedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            return nextToServe;
        });

        showNotification(`✅ Now serving: ${nextToServeData.studentName} (${nextToServeData.queueNumber}) at ${serviceInfo[service].name}`);
    } catch (error) {
        console.error('❌ Error serving next:', error);
        showNotification(`❌ Error serving next: ${error.message}`, true);
    }
}

async function adminCompleteServing() {
    if (!(await checkAdminPermissions())) {
        showNotification("❌ Unauthorized: Invalid Admin Code or not an Admin.", true);
        return;
    }

    const service = adminServiceSelect.value;
    if (!serviceInfo[service]) {
        showNotification('Invalid service selected.', true);
        return;
    }

    try {
        const servedCustomerData = await db.runTransaction(async (transaction) => {
            // FIX: Changed path to match existing DB structure: 'queues' and 'waitingList'
            const serviceDocRef = db.collection('queues').doc(service);
            const entriesCollectionRef = serviceDocRef.collection('waitingList');

            // Find the current serving customer
            const servingQuery = entriesCollectionRef
                .where('status', '==', 'serving')
                .limit(1);
            const servingSnapshot = await transaction.get(servingQuery);

            if (servingSnapshot.empty) {
                throw new Error('No one currently being served.');
            }

            const servedDoc = servingSnapshot.docs[0];
            const servedCustomer = servedDoc.data();

            // Update status to 'completed'
            transaction.update(servedDoc.ref, {
                status: 'completed',
                completedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            return servedCustomer;
        });

        showNotification(`✅ Completed serving: ${servedCustomerData.studentName} (${servedCustomerData.queueNumber}) at ${serviceInfo[service].name}`);
    } catch (error) {
        console.error('❌ Error completing serving:', error);
        showNotification(`❌ Error completing serving: ${error.message}`, true);
    }
}

async function adminResetQueue() {
    if (!(await checkAdminPermissions())) {
        showNotification("❌ Unauthorized: Invalid Admin Code or not an Admin.", true);
        return;
    }

    const service = adminServiceSelect.value;
    if (!serviceInfo[service]) {
        showNotification('Invalid service selected.', true);
        return;
    }

    if (!confirm(`Are you sure you want to reset the ${serviceInfo[service].name} queue? This cannot be undone.`)) {
        return;
    }

    try {
        await db.runTransaction(async (transaction) => {
            // FIX: Changed path to match existing DB structure: 'queues' and 'waitingList'
            const serviceDocRef = db.collection('queues').doc(service);
            const entriesCollectionRef = serviceDocRef.collection('waitingList');

            // Find all active entries (waiting or serving) for this service
            const activeEntriesQuery = entriesCollectionRef
                .where('status', 'in', ['waiting', 'serving'])
                .orderBy('timestamp', 'asc')
            const activeEntriesSnapshot = await transaction.get(activeEntriesQuery);

            // Mark all active entries as 'completed' (or delete them if preferred)
            activeEntriesSnapshot.docs.forEach(doc => {
                transaction.update(doc.ref, {
                    status: 'completed',
                    completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    resetByAdmin: true // Optional: Mark that it was reset
                });
            });

            // Reset nextQueueNumber for the service
            transaction.update(serviceDocRef, {
                nextQueueNumber: 1
            });
        });

        showNotification(`✅ Queue for ${serviceInfo[service].name} has been reset.`);
    } catch (error) {
        console.error('❌ Error resetting queue:', error);
        showNotification(`❌ Error resetting queue: ${error.message}`, true);
    }
}

async function adminGetAllQueues() {
    if (!(await checkAdminPermissions())) {
        showNotification("❌ Unauthorized: Invalid Admin Code or not an Admin.", true);
        return;
    }

    try {
        let allQueuesData = '<h3>📊 All Queues Data Overview</h3>';
        for (const serviceId in serviceInfo) {
            // FIX: Changed path to match existing DB structure: 'queues'
            const serviceDocRef = db.collection('queues').doc(serviceId);
            const serviceDoc = await serviceDocRef.get();
            let currentNextQueueNumber = 1;
            let serviceDisplayName = serviceInfo[serviceId].name;

            if (serviceDoc.exists) {
                const serviceData = serviceDoc.data();
                currentNextQueueNumber = serviceData.nextQueueNumber || 1;
                serviceDisplayName = serviceData.name || serviceDisplayName;
            }

            // FIX: Changed path to match existing DB structure: 'waitingList'
            const entriesSnapshot = await serviceDocRef.collection('waitingList')
                .where('status', 'in', ['waiting', 'serving'])
                .orderBy('timestamp', 'asc')
                .get();
            const queueEntries = entriesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const waiting = queueEntries.filter(q => q.status === 'waiting');
            const serving = queueEntries.find(q => q.status === 'serving');

            allQueuesData += `<h4>${serviceDisplayName}</h4>`;
            allQueuesData += `<p>Next Queue Number to assign: ${currentNextQueueNumber}</p>`;
            allQueuesData += `<p>Waiting: ${waiting.length} customer(s)</p>`;
            allQueuesData += `<p>Serving: ${serving ? serving.queueNumber + ' - ' + serving.studentName : 'No one'}</p>`;
            allQueuesData += `<hr>`;
        }
        alert(allQueuesData); // Using alert for simplicity, consider a modal for better UX
    } catch (error) {
        console.error('❌ Error getting all queues data:', error);
        showNotification(`❌ Failed to retrieve all queues data: ${error.message}`, true);
    }
}


// --- Event Listeners and Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    loadServices();
});

// Expose functions to the global scope for onclick events in HTML
window.joinQueue = joinQueue;
window.displayQueueStatus = displayQueueStatus;
window.adminServeNext = adminServeNext;
window.adminCompleteServing = adminCompleteServing;
window.adminResetQueue = adminResetQueue;
window.adminGetAllQueues = adminGetAllQueues;