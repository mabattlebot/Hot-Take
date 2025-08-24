// src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css'; // Assuming you have a CSS file for global styles

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// src/App.js
import React, { useEffect, useMemo, useState } from "react";
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// --- Global Variables (from Canvas environment) ---
// In a real app, you would use a .env file or similar for these config values.
const __app_id = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const __firebase_config = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const __initial_auth_token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- Utility Functions ---
const nowISO = () => new Date().toISOString();
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

// --- Scoring Logic ---
function settleScores(pred, usersMap) {
  const total = pred.votes.hot.length + pred.votes.cold.length;
  if (total === 0) return usersMap;

  const winners = pred.outcome === "hot" ? pred.votes.hot : pred.votes.cold;
  const losers = pred.outcome === "hot" ? pred.votes.cold : pred.votes.hot;
  const loseCount = losers.length;

  const minorityFactor = total === 0 ? 0 : loseCount / total;
  const authorBase = 10;
  const authorBonus = Math.round(20 * minorityFactor);
  const voterBase = 5;
  const voterBonus = Math.round(10 * minorityFactor);

  const next = new Map(usersMap);
  const authorAndCollabs = [pred.authorId, ...pred.collaborators];
  const authorCorrect = pred.outcome === "hot";

  if (authorCorrect) {
    const totalPoints = authorBase + authorBonus;
    const share = Math.max(1, Math.round(totalPoints / authorAndCollabs.length));
    for (const u of authorAndCollabs) {
      const user = new Map(next.get(u));
      user.set("points", (user.get("points") || 0) + share);
      user.set("streak", (user.get("streak") || 0) + 1);
      next.set(u, user);
    }
  } else {
    for (const u of authorAndCollabs) {
      const user = new Map(next.get(u));
      user.set("points", (user.get("points") || 0) - 5);
      user.set("streak", 0);
      next.set(u, user);
    }
  }

  for (const u of winners) {
    const user = new Map(next.get(u));
    user.set("points", (user.get("points") || 0) + voterBase + voterBonus);
    user.set("streak", (user.get("streak") || 0) + 1);
    next.set(u, user);
  }
  for (const u of losers) {
    const user = new Map(next.get(u));
    user.set("streak", 0);
    next.set(u, user);
  }

  return next;
}

// Converts a user array into a Map for efficient lookups.
function toUsersMap(users) {
  const m = new Map();
  users.forEach((u) => m.set(u.id, new Map(Object.entries(u))));
  return m;
}

// --- UI Components ---
function Pill({ children, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 border-4 border-red-800 text-sm font-bold transition-all
        ${active ? "bg-red-800 text-yellow-300 drop-shadow-[6px_6px_0_rgba(153,27,27,1)]" : "bg-white text-red-800 drop-shadow-[4px_4px_0_rgba(153,27,27,1)] hover:bg-yellow-300 hover:text-red-800"}
      `}
    >
      {children}
    </button>
  );
}

function Section({ title, children, right }) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-extrabold text-red-900">{title}</h2>
        <div>{right}</div>
      </div>
      <div className="bg-white border-4 border-red-800 drop-shadow-[6px_6px_0_rgba(153,27,27,1)] p-6">{children}</div>
    </div>
  );
}

function TextInput({ label, value, setValue, placeholder, type = "text" }) {
  return (
    <label className="block mb-3">
      <div className="text-sm font-bold text-red-900 mb-1">{label}</div>
      <input
        type={type}
        className="w-full border-4 border-red-800 bg-white p-3 font-mono text-red-900 focus:ring-0 focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function TextArea({ label, value, setValue, placeholder }) {
  return (
    <label className="block mb-3">
      <div className="text-sm font-bold text-red-900 mb-1">{label}</div>
      <textarea
        className="w-full border-4 border-red-800 bg-white p-3 font-mono text-red-900 focus:ring-0 focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
    </label>
  );
}

function Select({ label, value, setValue, options }) {
  return (
    <label className="block mb-3">
      <div className="text-sm font-bold text-red-900 mb-1">{label}</div>
      <select
        className="w-full border-4 border-red-800 bg-white p-3 font-mono text-red-900 focus:ring-0 focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// A component to display the time remaining until a deadline.
function TimeLeft({ iso }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return <span className="text-red-600 font-extrabold">CLOSED</span>;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    <span className="text-red-900 font-extrabold">{h}h {m}m {sec}s</span>
  );
}

// --- Chat Panel Component ---
function ChatPanel({ db, appId, predId, currentUserId, currentUsername }) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");

  // Set up real-time listener for chat messages
  useEffect(() => {
    if (!db || !appId || !predId) return;
    const chatCollectionRef = collection(db, `/artifacts/${appId}/public/data/predictions/${predId}/chat`);
    const unsub = onSnapshot(chatCollectionRef, (snapshot) => {
      const msgs = snapshot.docs.map(doc => doc.data());
      // Sort messages by timestamp after fetching
      msgs.sort((a, b) => (a.timestamp && b.timestamp) ? a.timestamp.toMillis() - b.timestamp.toMillis() : 0);
      setMessages(msgs);
    });
    return () => unsub();
  }, [db, appId, predId]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    try {
      const chatCollectionRef = collection(db, `/artifacts/${appId}/public/data/predictions/${predId}/chat`);
      await addDoc(chatCollectionRef, {
        authorId: currentUserId,
        authorName: currentUsername,
        text: newMessage,
        timestamp: serverTimestamp(),
      });
      setNewMessage("");
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  return (
    <div className="mt-6 border-4 border-red-800 p-4">
      <h4 className="text-lg font-extrabold text-red-900 mb-2">DISCUSSION</h4>
      <div className="h-64 overflow-y-auto mb-4 p-2 border-2 border-red-800 bg-red-50 font-mono">
        {messages.length === 0 ? (
          <div className="text-gray-500 text-center text-sm mt-8">NO MESSAGES YET. BE THE FIRST TO COMMENT!</div>
        ) : (
          messages.map((msg, index) => (
            <div key={index} className="mb-2 text-sm">
              <span className="font-bold text-red-900">{msg.authorName}:</span>{" "}
              <span className="text-gray-700">{msg.text}</span>
            </div>
          ))
        )}
      </div>
      <form onSubmit={handleSendMessage} className="flex gap-2">
        <input
          type="text"
          className="flex-1 border-4 border-red-800 p-2 bg-white font-mono"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="SEND A MESSAGE..."
        />
        <button type="submit" className="px-4 py-2 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors">
          SEND
        </button>
      </form>
    </div>
  );
}

// --- Main App ---
function App() {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [userId, setUserId] = useState(null);
  const [appId, setAppId] = useState(__app_id);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isUserInitialized, setIsUserInitialized] = useState(false);
  const [isPromptingForUsername, setIsPromptingForUsername] = useState(false);

  const [users, setUsers] = useState([]);
  const [preds, setPreds] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("Feed");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [message, setMessage] = useState(null);
  const [editingPred, setEditingPred] = useState(null);
  const [predToDelete, setPredToDelete] = useState(null);
  const [openChats, setOpenChats] = useState({});

  // Custom Message/Alert Modal
  function MessageModal({ title, content, onConfirm, onClose }) {
    return (
      <div className="fixed inset-0 bg-red-900 bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-white border-4 border-red-800 drop-shadow-[6px_6px_0_rgba(153,27,27,1)] p-6 max-w-sm w-full">
          <h3 className="font-extrabold text-xl text-red-900 mb-2">{title}</h3>
          <p className="font-mono text-gray-700 mb-4">{content}</p>
          <div className="flex justify-end gap-2">
            {onConfirm && (
              <button
                className="px-4 py-2 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors"
                onClick={onConfirm}
              >
                CONFIRM
              </button>
            )}
            {onClose && (
              <button
                className="px-4 py-2 border-4 border-red-800 bg-white text-red-800 font-extrabold hover:bg-red-200 transition-colors"
                onClick={onClose}
              >
                CLOSE
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Initialize Firebase and set up auth listener
  useEffect(() => {
    const app = initializeApp(__firebase_config);
    const db = getFirestore(app);
    const auth = getAuth(app);
    const storage = getStorage(app);

    setDb(db);
    setAuth(auth);
    setStorage(storage);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
        setIsAuthReady(true);
      } else {
        try {
          if (__initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
          } else {
            await signInAnonymously(auth);
          }
        } catch (error) {
          console.error("Authentication failed:", error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch initial user data after authentication is ready
  useEffect(() => {
    if (!isAuthReady || !db || !auth || !appId) return;

    const meRef = doc(db, `/artifacts/${appId}/users/${userId}/private/me`);

    const initializeUser = async () => {
      try {
        const docSnap = await getDoc(meRef);
        if (docSnap.exists()) {
          const userData = docSnap.data();
          setCurrentUser({ id: userId, ...userData });
          setIsUserInitialized(true);
        } else {
          setIsPromptingForUsername(true);
        }
      } catch (error) {
        console.error("Error initializing user data:", error);
        setMessage({ title: "Error", content: "Failed to load user profile." });
      }
    };
    initializeUser();
  }, [isAuthReady, db, auth, appId, userId]);

  // Set up real-time listeners for users and predictions
  useEffect(() => {
    if (!isUserInitialized || !db || !appId) return;

    const usersCollectionRef = collection(db, `/artifacts/${appId}/public/data/users`);
    const usersUnsub = onSnapshot(usersCollectionRef, (querySnapshot) => {
      const usersList = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setUsers(usersList);
    });

    const predsCollectionRef = collection(db, `/artifacts/${appId}/public/data/predictions`);
    const predsUnsub = onSnapshot(predsCollectionRef, (querySnapshot) => {
      const predsList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        chatCount: 0
      }));
      setPreds(predsList);
    });
    return () => {
      usersUnsub();
      predsUnsub();
    };
  }, [isUserInitialized, db, appId]);

  // Use a memoized map for efficient user lookups.
  const usersMap = useMemo(() => toUsersMap(users), [users]);

  // Generate a list of all categories, including user-added ones.
  const categories = useMemo(() => {
    const base = new Set(["All", "Sports", "Tech", "Pop Culture", "World", "Finance", "Science"]);
    preds.forEach((p) => base.add(p.category));
    return Array.from(base);
  }, [preds]);

  async function addFriend(friendId) {
    if (!friendId || friendId === userId) {
      setMessage({ title: "Error", content: "Invalid user ID or cannot add yourself as a friend." });
      return;
    }

    try {
      const myFriends = currentUser.friends;
      if (myFriends.includes(friendId)) return;

      const myUserRef = doc(db, `/artifacts/${appId}/users/${userId}/private/me`);
      const publicUserRef = doc(db, `/artifacts/${appId}/public/data/users/${userId}`);

      await updateDoc(myUserRef, { friends: [...myFriends, friendId] });
      await updateDoc(publicUserRef, { friends: [...myFriends, friendId] });
      setMessage({ title: "Success", content: "Friend added!" });
    } catch (error) {
      console.error("Failed to add friend:", error);
      setMessage({ title: "Error", content: "Failed to add friend." });
    }
  }

  // Create a new prediction.
  async function createPrediction(p) {
    try {
      const predictionsCollectionRef = collection(db, `/artifacts/${appId}/public/data/predictions`);
      const newPrediction = {
        title: p.title.trim(),
        category: p.category,
        description: p.description.trim(),
        authorId: userId,
        authorName: currentUser.username,
        collaborators: p.collaborators,
        createdAt: nowISO(),
        closeAt: p.closeAt,
        imageUrl: p.imageUrl,
        votes: { hot: [], cold: [] },
        resolved: false,
        outcome: null,
        scored: false,
        challenge: p.challenge || null,
      };
      await addDoc(predictionsCollectionRef, newPrediction);
      setTab("Feed");
    } catch (error) {
      console.error("Failed to create prediction:", error);
      setMessage({ title: "Error", content: "Failed to create prediction." });
    }
  }

  // Update an existing prediction.
  async function updatePrediction(predId, updatedData) {
    try {
      const predRef = doc(db, `/artifacts/${appId}/public/data/predictions/${predId}`);
      await updateDoc(predRef, updatedData);
      setEditingPred(null);
    } catch (error) {
      console.error("Failed to update prediction:", error);
      setMessage({ title: "Error", content: "Failed to update take." });
    }
  }

  async function confirmDelete() {
    try {
      if (!predToDelete) return;
      const predRef = doc(db, `/artifacts/${appId}/public/data/predictions/${predToDelete}`);
      const pred = preds.find(p => p.id === predToDelete);
      if (pred && pred.imageUrl) {
        const imageRef = storageRef(storage, pred.imageUrl);
        await deleteObject(imageRef);
      }
      await deleteDoc(predRef);
      setPredToDelete(null);
    } catch (error) {
      console.error("Failed to delete prediction:", error);
      setMessage({ title: "Error", content: "Failed to delete take." });
    }
  }

  // Toggle a user's vote on a prediction.
  async function toggleVote(predId, side) {
    const predRef = doc(db, `/artifacts/${appId}/public/data/predictions/${predId}`);
    const pred = preds.find(p => p.id === predId);
    if (!pred || pred.resolved || new Date(pred.closeAt).getTime() <= Date.now()) return;
    if (pred.authorId === userId || pred.collaborators.includes(userId)) {
      setMessage({ title: "Error", content: "You cannot vote on your own take." });
      return;
    }

    const hot = new Set(pred.votes.hot);
    const cold = new Set(pred.votes.cold);

    hot.delete(userId);
    cold.delete(userId);

    if (side === "hot") hot.add(userId); else cold.add(userId);

    try {
      await updateDoc(predRef, {
        votes: { hot: Array.from(hot), cold: Array.from(cold) }
      });
    } catch (error) {
      console.error("Failed to toggle vote:", error);
      setMessage({ title: "Error", content: "Failed to cast vote." });
    }
  }

  // Check if the current user can resolve a prediction.
  function canResolve(p) {
    return (
      (p.authorId === userId || p.collaborators.includes(userId)) &&
      new Date(p.closeAt).getTime() <= Date.now() &&
      !p.resolved
    );
  }

  // Resolve a prediction and trigger scoring.
  async function resolve(predId, outcome) {
    const predRef = doc(db, `/artifacts/${appId}/public/data/predictions/${predId}`);
    try {
      await updateDoc(predRef, { resolved: true, outcome });

      const pred = preds.find(p => p.id === predId);
      if (pred && !pred.scored) {
        const nextUsersMap = settleScores(pred, usersMap);

        for (const [id, vals] of nextUsersMap.entries()) {
          const userDocRef = doc(db, `/artifacts/${appId}/public/data/users/${id}`);
          const privateUserDocRef = doc(db, `/artifacts/${appId}/users/${id}/private/me`);

          await setDoc(userDocRef, {
            username: vals.get("username"),
            points: vals.get("points"),
            friends: vals.get("friends"),
            badges: vals.get("badges"),
            streak: vals.get("streak"),
          });

          await setDoc(privateUserDocRef, {
            username: vals.get("username"),
            points: vals.get("points"),
            friends: vals.get("friends"),
            badges: vals.get("badges"),
            streak: vals.get("streak"),
          });
        }
        await updateDoc(predRef, { scored: true });
      }
    } catch (error) {
      console.error("Failed to resolve prediction or update scores:", error);
      setMessage({ title: "Error", content: "Failed to resolve prediction." });
    }
  }

  // Automatically assign badges based on user stats.
  function autoBadge(u) {
    const usr = users.find((x) => x.id === u.id);
    if (!usr) return [];
    const b = new Set(usr.badges);
    if (usr.points >= 100) b.add("Centurion");
    if (usr.streak >= 5) b.add("Hot Streak 5");
    return Array.from(b);
  }

  // Memoize the sorted leaderboard for performance.
  const leaderboard = useMemo(() => [...users].sort((a, b) => b.points - a.points), [users]);

  // Filter predictions based on search and category filters.
  const filtered = useMemo(() => {
    return preds
      .filter((p) => (categoryFilter === "All" ? true : p.category === categoryFilter))
      .filter((p) => (search ? (p.title + " " + p.description).toLowerCase().includes(search.toLowerCase()) : true));
  }, [preds, categoryFilter, search]);

  // Handle username submission
  async function handleUsernameSubmit(username) {
    username = username.trim();
    if (!username) {
      setMessage({ title: "Error", content: "Username cannot be empty." });
      return;
    }

    const usersCollectionRef = collection(db, `/artifacts/${appId}/public/data/users`);
    const q = query(usersCollectionRef, where("username", "==", username));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) {
      setMessage({ title: "Error", content: "Username already taken. Please choose another." });
      return;
    }

    try {
      const newUser = {
        username: username,
        points: 0,
        friends: [],
        badges: [],
        streak: 0,
      };

      const meRef = doc(db, `/artifacts/${appId}/users/${userId}/private/me`);
      const publicUserRef = doc(db, `/artifacts/${appId}/public/data/users/${userId}`);

      await setDoc(meRef, newUser);
      await setDoc(publicUserRef, { username: newUser.username, points: newUser.points, friends: newUser.friends, badges: newUser.badges, streak: newUser.streak });

      setCurrentUser({ id: userId, ...newUser });
      setIsUserInitialized(true);
      setIsPromptingForUsername(false);
    } catch (error) {
      console.error("Failed to create user profile:", error);
      setMessage({ title: "Error", content: "Failed to create user profile. Please try again." });
    }
  }

  if (!isUserInitialized && !isPromptingForUsername) {
    return (
      <div className="min-h-screen bg-amber-50 text-red-900 font-sans antialiased p-4 grid place-items-center">
        <div className="text-center text-xl font-bold">LOADING...</div>
      </div>
    );
  }

  if (isPromptingForUsername) {
    return (
      <div className="min-h-screen bg-amber-50 text-red-900 font-sans antialiased p-4 grid place-items-center">
        <div className="bg-white border-4 border-red-800 drop-shadow-[6px_6px_0_rgba(153,27,27,1)] p-8 max-w-sm w-full">
          <h2 className="text-xl font-extrabold text-red-900 mb-4">WELCOME!</h2>
          <p className="font-mono text-gray-700 mb-4">Please enter a username to get started.</p>
          <form onSubmit={(e) => {
            e.preventDefault();
            const input = e.target.elements.username.value;
            handleUsernameSubmit(input);
          }}>
            <input
              name="username"
              className="w-full border-4 border-red-800 bg-white p-3 font-mono focus:ring-0 focus:outline-none mb-4"
              placeholder="Your Username"
            />
            <button
              type="submit"
              className="w-full px-4 py-3 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors"
            >
              LET'S GO!
            </button>
          </form>
          {message && message.content && (
            <div className="mt-4 text-center font-bold text-red-600">{message.content}</div>
          )}
        </div>
      </div>
    );
  }

  // --- Small Components ---
  function PredictionCard({ p }) {
    const isAuthor = p.authorId === userId;
    const closed = new Date(p.closeAt).getTime() <= Date.now();
    const canVote = !p.resolved && !closed && !isAuthor && !p.collaborators.includes(userId);
    const userVote = p.votes.hot.includes(userId) ? "hot" : p.votes.cold.includes(userId) ? "cold" : null;
    const totalVotes = p.votes.hot.length + p.votes.cold.length;
    const authorName = users.find(u => u.id === p.authorId)?.username || "Unknown";
    const collaboratorNames = p.collaborators.map(cId => users.find(u => u.id === cId)?.username).filter(Boolean);
    const chatIsOpen = openChats[p.id];
    const [chatCount, setChatCount] = useState(0);

    useEffect(() => {
      if (!db || !appId) return;
      const chatCollectionRef = collection(db, `/artifacts/${appId}/public/data/predictions/${p.id}/chat`);
      const unsub = onSnapshot(chatCollectionRef, (snapshot) => {
        setChatCount(snapshot.docs.length);
      });
      return () => unsub();
    }, [db, appId, p.id]);

    const toggleChat = () => {
      setOpenChats(prev => ({
        ...prev,
        [p.id]: !prev[p.id]
      }));
    };

    if (editingPred && editingPred.id === p.id) {
      return (
        <EditPredictionPanel
          pred={editingPred}
          onSave={(updatedData) => updatePrediction(p.id, updatedData)}
          onCancel={() => setEditingPred(null)}
          categories={categories.filter(c => c !== "All")}
          storage={storage}
        />
      );
    }

    return (
      <div className="border-4 border-red-800 drop-shadow-[6px_6px_0_rgba(153,27,27,1)] bg-white p-6 mb-4">
        {p.imageUrl && (
          <div className="mb-4 overflow-hidden rounded-md border-2 border-red-800 drop-shadow-[4px_4px_0_rgba(153,27,27,1)]">
            <img
              src={p.imageUrl}
              alt="Hot Take related media"
              className="w-full object-cover"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src="https://placehold.co/600x400/CCCCCC/000000?text=Image+Not+Found";
              }}
            />
          </div>
        )}
        <div className="flex items-start gap-4">
          <div className="grow">
            <div className="flex items-center justify-between mb-2">
              <div className="font-extrabold text-2xl text-red-900">{p.title}</div>
              <span className="text-xs px-2 py-1 border-4 border-red-800 bg-yellow-300 font-bold">{p.category.toUpperCase()}</span>
            </div>
            <div className="font-mono text-gray-700 mt-1">{p.description}</div>
            <div className="text-sm font-bold text-gray-800 mt-2">
              BY <span className="font-extrabold text-red-900">{authorName.toUpperCase()}</span>
              {collaboratorNames.length > 0 && (
                <>
                  {" "}· COLLAB WITH {collaboratorNames.join(", ").toUpperCase()}
                </>
              )}
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mt-3 text-sm">
              <div className="font-extrabold text-red-900">
                DEADLINE: {" "}
                <TimeLeft iso={p.closeAt} />
              </div>
              <div className="font-bold text-red-900">VOTES: {totalVotes} (🔥 {p.votes.hot.length} / ❄️ {p.votes.cold.length})</div>
              {p.challenge && (
                <span className="text-red-600 font-extrabold">CHALLENGE VS {users.find(u => u.id === p.challenge.opponent)?.username.toUpperCase() || "UNKNOWN"}</span>
              )}
            </div>

            {!p.resolved && closed && canResolve(p) && (
              <div className="mt-4 flex flex-col sm:flex-row gap-2">
                <button className="px-4 py-2 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors" onClick={() => resolve(p.id, "hot")}>
                  RESOLVE: HOT (TRUE)
                </button>
                <button className="px-4 py-2 border-4 border-red-800 bg-gray-800 text-white font-extrabold hover:bg-white hover:text-red-800 transition-colors" onClick={() => resolve(p.id, "cold")}>
                  RESOLVE: COLD (FALSE)
                </button>
              </div>
            )}

            {p.resolved && (
              <div className="mt-4">
                <span className={`px-2 py-1 border-4 border-red-800 text-sm font-extrabold ${
                  p.outcome === "hot" ? "bg-orange-500 text-red-900" : "bg-sky-500 text-red-900"
                }`}>
                  RESOLVED: {p.outcome === "hot" ? "TRUE (HOT)" : "FALSE (COLD)"}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {isAuthor ? (
            <>
              <button
                className="flex-1 px-4 py-3 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors"
                onClick={() => setEditingPred(p)}
              >
                EDIT TAKE
              </button>
              <button
                className="flex-1 px-4 py-3 border-4 border-red-800 bg-red-500 text-white font-extrabold hover:bg-red-600 transition-colors"
                onClick={() => setPredToDelete(p.id)}
              >
                DELETE TAKE
              </button>
            </>
          ) : (
            <>
              <button
                disabled={!canVote}
                onClick={() => toggleVote(p.id, "hot")}
                className={`flex-1 px-4 py-3 border-4 border-red-800 font-extrabold transition-all ${
                  userVote === "hot" ? "bg-orange-500 text-white" : "bg-red-500 text-white drop-shadow-[4px_4px_0_rgba(153,27,27,1)] hover:bg-orange-600"
                } ${!canVote ? "opacity-50 cursor-not-allowed drop-shadow-none" : ""}`}
              >
                🔥 HOT
              </button>
              <button
                disabled={!canVote}
                onClick={() => toggleVote(p.id, "cold")}
                className={`flex-1 px-4 py-3 border-4 border-red-800 font-extrabold transition-all ${
                  userVote === "cold" ? "bg-sky-500 text-white" : "bg-sky-700 text-white drop-shadow-[4px_4px_0_rgba(153,27,27,1)] hover:bg-sky-600"
                } ${!canVote ? "opacity-50 cursor-not-allowed drop-shadow-none" : ""}`}
              >
                ❄️ COLD
              </button>
            </>
          )}
        </div>
        <div className="mt-4">
          <button onClick={toggleChat} className="px-4 py-2 border-4 border-red-800 bg-white text-red-800 font-extrabold drop-shadow-[4px_4px_0_rgba(153,27,27,1)] hover:bg-yellow-300 transition-colors">
            💬 CHAT ({chatCount})
          </button>
        </div>
        {chatIsOpen && (
          <ChatPanel
            db={db}
            appId={appId}
            predId={p.id}
            currentUserId={userId}
            currentUsername={currentUser.username}
          />
        )}
      </div>
    );
  }

  function CreatePanel() {
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState("Sports");
    const [description, setDescription] = useState("");
    const [imageFile, setImageFile] = useState(null);
    const [imageUrlPreview, setImageUrlPreview] = useState(null);
    const [isUploading, setIsUploading] = useState(false);
    const [deadline, setDeadline] = useState(() => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0,16));
    const [collabInput, setCollabInput] = useState("");
    const [collabs, setCollabs] = useState([]);
    const [challengeOpponent, setChallengeOpponent] = useState("");

    useEffect(() => {
      if (imageFile) {
        setImageUrlPreview(URL.createObjectURL(imageFile));
      } else {
        setImageUrlPreview(null);
      }
    }, [imageFile]);

    function handleFileChange(e) {
      if (e.target.files[0]) {
        setImageFile(e.target.files[0]);
      } else {
        setImageFile(null);
      }
    }

    async function handlePostTake() {
      if (!title.trim()) {
        setMessage({ title: "Error", content: "Title cannot be empty." });
        return;
      }
      if (new Date(deadline).getTime() <= Date.now()) {
        setMessage({ title: "Error", content: "Deadline must be in the future." });
        return;
      }

      setIsUploading(true);
      let newImageUrl = null;
      if (imageFile) {
        try {
          const storageRef_ = storageRef(storage, `images/${Date.now()}_${imageFile.name}`);
          await uploadBytes(storageRef_, imageFile);
          newImageUrl = await getDownloadURL(storageRef_);
        } catch (error) {
          console.error("Image upload failed:", error);
          setMessage({ title: "Error", content: "Failed to upload image. Please try again." });
          setIsUploading(false);
          return;
        }
      }
      setIsUploading(false);

      createPrediction({
        title,
        category,
        description,
        imageUrl: newImageUrl,
        collaborators: collabs,
        closeAt: new Date(deadline).toISOString(),
        challenge: challengeOpponent ? { opponent: users.find(u => u.username === challengeOpponent)?.id || null } : null,
      });
    }

    function addCollab() {
      const name = collabInput.trim();
      const user = users.find(u => u.username === name);
      if (!name || name === currentUser.username || !user) {
        setMessage({ title: "Error", content: "Invalid collaborator username or user not found." });
        return;
      }
      const newCollabsSet = new Set(collabs);
      newCollabsSet.add(user.id);
      setCollabs(Array.from(newCollabsSet));
      setCollabInput("");
    }

    return (
      <div>
        <TextInput label="TITLE" value={title} setValue={setTitle} placeholder="YOUR BOLD PREDICTION..." />
        <label className="block mb-3">
          <div className="text-sm font-bold text-red-900 mb-1">IMAGE (OPTIONAL)</div>
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-red-800 file:text-yellow-300
              hover:file:bg-yellow-300 hover:file:text-red-800"
          />
        </label>
        {imageUrlPreview && (
          <div className="mb-4 overflow-hidden rounded-md border-2 border-red-800 drop-shadow-[4px_4px_0_rgba(153,27,27,1)]">
            <img src={imageUrlPreview} alt="Image preview" className="w-full object-cover" />
          </div>
        )}
        <Select label="CATEGORY" value={category} setValue={setCategory} options={categories.filter(c=>c!=="All")} />
        <TextArea label="DETAILS" value={description} setValue={setDescription} placeholder="ADD CONTEXT, SOURCES, OR SPICY REASONING." />
        <TextInput type="datetime-local" label="DEADLINE" value={deadline} setValue={setDeadline} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border-4 border-red-800 p-4">
            <div className="text-sm font-extrabold text-red-900 mb-2">COLLABORATORS</div>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 border-4 border-red-800 p-2 bg-white font-mono" value={collabInput} onChange={(e)=>setCollabInput(e.target.value)} placeholder="FRIEND USERNAME" />
              <button className="px-4 py-2 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors" onClick={addCollab}>ADD</button>
            </div>
            <div className="flex gap-2 flex-wrap">
              {collabs.map((cId) => {
                const collabUser = users.find(u => u.id === cId);
                return collabUser ? (
                  <span key={cId} className="px-2 py-1 border-2 border-red-800 bg-red-200 text-sm font-bold">{collabUser.username.toUpperCase()}</span>
                ) : null;
              })}
            </div>
          </div>
          <div className="border-4 border-red-800 p-4">
            <div className="text-sm font-extrabold text-red-900 mb-2">HEAD-TO-HEAD (OPTIONAL)</div>
            <input className="w-full border-4 border-red-800 p-3 bg-white font-mono" value={challengeOpponent} onChange={(e)=>setChallengeOpponent(e.target.value)} placeholder="OPPONENT USERNAME" />
            <div className="text-xs text-gray-500 font-bold mt-2">CREATES A MINI CHALLENGE BADGE VS OPPONENT.</div>
          </div>
        </div>
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <button onClick={handlePostTake} disabled={isUploading} className="flex-1 px-4 py-3 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors">
            {isUploading ? "UPLOADING..." : "POST TAKE"}
          </button>
          <button onClick={()=>setTab("Feed")} className="flex-1 px-4 py-3 border-4 border-red-800 bg-white text-red-800 font-extrabold hover:bg-red-500 hover:text-white transition-colors">CANCEL</button>
        </div>
      </div>
    );
  }

  function EditPredictionPanel({ pred, onSave, onCancel, categories, storage }) {
    const [title, setTitle] = useState(pred.title);
    const [category, setCategory] = useState(pred.category);
    const [description, setDescription] = useState(pred.description);
    const [imageFile, setImageFile] = useState(null);
    const [imageUrlPreview, setImageUrlPreview] = useState(pred.imageUrl);
    const [isUploading, setIsUploading] = useState(false);
    const [deadline, setDeadline] = useState(pred.closeAt.slice(0, 16));

    useEffect(() => {
      if (imageFile) {
        setImageUrlPreview(URL.createObjectURL(imageFile));
      } else if (!pred.imageUrl) {
        setImageUrlPreview(null);
      } else {
        setImageUrlPreview(pred.imageUrl);
      }
    }, [imageFile, pred.imageUrl]);

    function handleFileChange(e) {
      if (e.target.files[0]) {
        setImageFile(e.target.files[0]);
      } else {
        setImageFile(null);
      }
    }

    async function handleSave() {
      if (!title.trim()) {
        setMessage({ title: "Error", content: "Title cannot be empty." });
        return;
      }
      if (new Date(deadline).getTime() <= Date.now()) {
        setMessage({ title: "Error", content: "Deadline must be in the future." });
        return;
      }

      setIsUploading(true);
      let newImageUrl = pred.imageUrl;

      if (imageFile) {
        try {
          if (pred.imageUrl) {
            const oldImageRef = storageRef(storage, pred.imageUrl);
            await deleteObject(oldImageRef);
          }
          const storageRef_ = storageRef(storage, `images/${Date.now()}_${imageFile.name}`);
          await uploadBytes(storageRef_, imageFile);
          newImageUrl = await getDownloadURL(storageRef_);
        } catch (error) {
        console.error("Image upload/delete failed:", error);
        setMessage({ title: "Error", content: "Failed to update image. Please try again." });
        setIsUploading(false);
        return;
      }
    }

    onSave({
      title: title.trim(),
      description: description.trim(),
      category,
      imageUrl: newImageUrl,
      closeAt: new Date(deadline).toISOString(),
    });
    setIsUploading(false);
  }

  return (
    <div className="bg-white border-4 border-red-800 drop-shadow-[6px_6px_0_rgba(153,27,27,1)] p-6 mb-4">
      <h3 className="text-xl font-extrabold text-red-900 mb-4">EDITING TAKE</h3>
      <TextInput label="TITLE" value={title} setValue={setTitle} placeholder="YOUR BOLD PREDICTION..." />
      <label className="block mb-3">
        <div className="text-sm font-bold text-red-900 mb-1">IMAGE (OPTIONAL)</div>
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-500
            file:mr-4 file:py-2 file:px-4
            file:rounded-full file:border-0
            file:text-sm file:font-semibold
            file:bg-red-800 file:text-yellow-300
            hover:file:bg-yellow-300 hover:file:text-red-800"
        />
      </label>
      {imageUrlPreview && (
        <div className="mb-4 overflow-hidden rounded-md border-2 border-red-800 drop-shadow-[4px_4px_0_rgba(153,27,27,1)]">
          <img src={imageUrlPreview} alt="Image preview" className="w-full object-cover" />
        </div>
      )}
      <Select label="CATEGORY" value={category} setValue={setCategory} options={categories.filter(c => c !== "All")} />
      <TextArea label="DETAILS" value={description} setValue={setDescription} placeholder="ADD CONTEXT, SOURCES, OR SPICY REASONING." />
      <TextInput type="datetime-local" label="DEADLINE" value={deadline} setValue={setDeadline} />
      <div className="mt-6 flex flex-col sm:flex-row gap-2">
        <button onClick={handleSave} disabled={isUploading} className="flex-1 px-4 py-3 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors">
          {isUploading ? "UPLOADING..." : "SAVE CHANGES"}
        </button>
        <button onClick={onCancel} className="flex-1 px-4 py-3 border-4 border-red-800 bg-white text-red-800 font-extrabold hover:bg-red-500 hover:text-white transition-colors">CANCEL</button>
      </div>
    </div>
  );
  }

  function FriendsPanel() {
    const [newFriendName, setNewFriendName] = useState("");
    const myFriends = currentUser?.friends || [];
    const friendPreds = preds.filter((p) => myFriends.includes(p.authorId));

    return (
      <div>
        <div className="flex gap-2 mb-4">
          <input className="flex-1 border-4 border-red-800 p-3 bg-white font-mono" value={newFriendName} onChange={(e)=>setNewFriendName(e.target.value)} placeholder="ADD FRIEND BY USERNAME" />
          <button className="px-4 py-2 border-4 border-red-800 bg-red-800 text-yellow-300 font-extrabold hover:bg-yellow-300 hover:text-red-800 transition-colors" onClick={async ()=>{
            const friendUser = users.find(u => u.username === newFriendName);
            if (friendUser) {
              await addFriend(friendUser.id);
            } else {
              setMessage({ title: "Error", content: `User "${newFriendName}" not found. Please check the spelling.` });
            }
            setNewFriendName("");
          }}>ADD</button>
        </div>
        <div className="text-sm font-bold text-gray-800 mb-4">FRIENDS: {myFriends.length ? myFriends.map(fId => users.find(u => u.id === fId)?.username || "Unknown").join(", ").toUpperCase() : "NO FRIENDS YET"}</div>
        <Section title="FRIENDS' TAKES">
          {friendPreds.length === 0 ? (
            <div className="text-gray-500 font-bold">NO FRIEND ACTIVITY YET.</div>
          ) : (
            friendPreds.map((p)=> <PredictionCard key={p.id} p={p} />)
          )}
        </Section>
      </div>
    );
  }

  function ProfilePanel() {
    const me = currentUser;
    const badges = autoBadge(me);
    const myPreds = preds.filter((p) => p.authorId === userId || p.collaborators.includes(userId));

    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-3xl font-extrabold text-red-900">@{me?.username?.toUpperCase() || ""}</div>
            <div className="text-gray-600 font-bold">POINTS: {me?.points ?? 0} · STREAK: {me?.streak ?? 0}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {badges.map((b)=> (
              <span key={b} className="px-2 py-1 border-4 border-red-800 bg-yellow-300 text-red-900 text-sm font-extrabold">{b.toUpperCase()}</span>
            ))}
          </div>
        </div>
        <div className="font-mono text-xs text-gray-500 break-all mb-4">USER ID: {userId}</div>
        <Section title="MY TAKES">
          {myPreds.length === 0 ? (
            <div className="text-gray-500 font-bold">YOU HAVEN'T POSTED ANY TAKES YET.</div>
          ) : (
            myPreds.map((p)=> <PredictionCard key={p.id} p={p} />)
          )}
        </Section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orange-50 text-red-900 font-sans antialiased p-4">
      {message && <MessageModal title={message.title} content={message.content} onClose={() => setMessage(null)} />}
      {predToDelete && (
        <MessageModal
          title="CONFIRM DELETION"
          content="Are you sure you want to delete this hot take? This action cannot be undone."
          onConfirm={confirmDelete}
          onClose={() => setPredToDelete(null)}
        />
      )}
      <div className="max-w-5xl mx-auto border-4 border-red-800 drop-shadow-[10px_10px_0_rgba(153,27,27,1)] bg-white p-4 sm:p-6 md:p-8">
        {/* Top Bar */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="text-3xl font-extrabold tracking-tight text-red-900">🔥 HOT TAKE</div>
            <span className="text-sm font-bold text-gray-800">THE PREDICTION ARENA</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-red-900">CURRENT USER: @{currentUser?.username?.toUpperCase() || "..."}</span>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {[
            "Feed",
            "Create",
            "Leaderboard",
            "Friends",
            "Profile",
          ].map((t)=>(
            <Pill key={t} active={tab===t} onClick={()=>setTab(t)}>{t.toUpperCase()}</Pill>
          ))}
        </div>
        {/* Search & Filters (Feed only) */}
        {tab === "Feed" && (
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <input className="flex-1 border-4 border-red-800 p-3 font-mono text-red-900" placeholder="SEARCH TAKES…" value={search} onChange={(e)=>setSearch(e.target.value)} />
            <select className="border-4 border-red-800 p-3 font-mono text-red-900" value={categoryFilter} onChange={(e)=>setCategoryFilter(e.target.value)}>
              {categories.map((c)=> <option key={c} value={c}>{c.toUpperCase()}</option>)}
            </select>
          </div>
        )}
        {/* Panels */}
        {tab === "Feed" && (
          <Section title="LIVE FEED" right={<div className="text-sm font-bold text-gray-600">{preds.length} TAKES</div>}>
            {filtered.length === 0 ? (
              <div className="text-gray-500 font-bold">NO TAKES YET. SWITCH TO <span className="font-extrabold">CREATE</span> TO POST YOUR FIRST ONE!</div>
            ) : (
              filtered.map((p) => <PredictionCard key={p.id} p={p} />)
            )}
          </Section>
        )}
        {tab === "Create" && (
          <Section title="DROP A NEW HOT TAKE">
            <CreatePanel />
          </Section>
        )}
        {tab === "Leaderboard" && (
          <Section title="LEADERBOARD" right={<div className="text-sm font-bold text-gray-600">TOP PREDICTORS</div>}>
            <div className="divide-y-4 divide-red-800">
              {leaderboard.map((u, i) => (
                <div key={u.id} className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 border-4 border-red-800 bg-yellow-300 text-red-900 grid place-items-center font-extrabold">{i+1}</div>
                    <div>
                      <div className="font-extrabold text-lg">{u.username?.toUpperCase() || "UNKNOWN"}</div>
                      <div className="text-xs font-bold text-gray-600">STREAK {u.streak}{u.streak>=5?" · 🔥":""}</div>
                    </div>
                  </div>
                  <div className="font-extrabold text-lg">{u.points} PTS</div>
                </div>
              ))}
            </div>
          </Section>
        )}
        {tab === "Friends" && (
          <Section title="FRIENDS">
            <FriendsPanel />
          </Section>
        )}
        {tab === "Profile" && (
          <Section title="MY PROFILE">
            <ProfilePanel />
          </Section>
        )}
        <div className="mt-8 text-center text-xs font-bold text-gray-500">
          POWERED BY FIREBASE AND REACT
        </div>
      </div>
    </div>
  );
}

export default App;