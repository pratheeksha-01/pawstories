/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Camera,
  Radar,
  Loader2,
  PawPrint,
  Stars,
  Upload,
  RefreshCcw,
  Zap,
  Download,
  Share2,
  AlertTriangle,
  Globe,
  Trash2,
  ShieldAlert,
  Instagram,
  Linkedin,
  Check,
  LogOut,
  ShieldCheck,
  Mail
} from 'lucide-react';
import { PrivacyModal, TermsModal } from '../../components/LegalModals';
import {
  auth,
  loginWithGoogle,
  logoutUser,
  onAuthStateChanged,
  getOrCreateUserProfile,
  submitQuotaRequest,
  UserProfile,
  FirebaseUser
} from '../../lib/firebase';

// --- AI Initialization ---

interface SavedGeneration {
  id: string;
  name: string;
  preview: string;
  genImage: string | null;
  result: {
    identity: string;
    talent: string;
    plan: string;
    zoomies: string;
    heist: string;
    nemesis: string;
    vibe: string;
    opHub: string;
    desc: string;
    codeId: string;
    imagePrompt?: string;
  };
  language: string;
  timestamp?: number;
  tokenUsage?: {
    textTokens?: { prompt: number; candidates: number; total: number };
    imageTokens?: { prompt: number; candidates: number; total: number };
    combinedTotal: number;
  };
}

const PREVIEW_MAX_DIM = 384;
const PREVIEW_QUALITY = 0.55;

function shrinkBase64Image(base64: string, maxDim = 400, quality = 0.6): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!base64 || !base64.startsWith('data:image')) {
      reject(new Error('INVALID PHOTO: Please select a valid pet image.'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (!w || !h) {
          reject(new Error('INVALID PHOTO: Please upload a non-empty pet image.'));
          return;
        }
        if (w > h) {
          if (w > maxDim) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          }
        } else {
          if (h > maxDim) {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to process image. Please try another photo.'));
          return;
        }
        if (base64.startsWith('data:image/jpeg') || base64.startsWith('data:image/jpg')) {
          ctx.drawImage(img, 0, 0, w, h);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
        }
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        console.warn("Failed to shrink image", err);
        reject(new Error('Failed to process image format. Please try another photo.'));
      }
    };
    img.onerror = () => {
      reject(new Error('INVALID PHOTO: Please upload a supported pet image.'));
    };
    img.src = base64;
  });
}

// Emails exempt from the 3-generation free quota (e.g. internal testing accounts).
// Configured via env rather than hardcoded so it's not baked into source control.
const TEST_ACCOUNT_EMAILS = ((import.meta as any).env?.VITE_TEST_ACCOUNT_EMAILS || '')
  .split(',')
  .map((e: string) => e.trim().toLowerCase())
  .filter(Boolean);

// User-facing copy for the human/invalid-photo rejection. Kept on the client so
// the analyze prompt stays short (fewer input tokens on every request).
const HUMAN_REJECT_MESSAGE =
  'HUMAN DETECTED OR INVALID PHOTO: Security clearance denied! We strictly only investigate pets. ' +
  'No humans allowed in our spy files. Please re-upload a clear photo of your pet!';

// Lightweight structured client logger. Mirrors the server's event-shaped logs
// so browser + server traces read the same way.
function logClient(event: string, fields: Record<string, unknown> = {}) {
  console.info(`[paw] ${event}`, fields);
}

// Builds the strong, concrete "spy makeover" image prompt from a dossier result.
// The analyzer's short imagePrompt is only used as extra creative direction — on
// its own it's too vague and the editing model just returns the original photo.
function buildImagePrompt(petName: string, analysis: SavedGeneration['result']) {
  const creativeDirection = analysis.imagePrompt ? ` Creative direction: ${analysis.imagePrompt}.` : '';
  return (
    `Re-imagine this exact pet, "${petName}", as the undercover secret agent "${analysis.identity}" ` +
    `(codename ${analysis.codeId || 'CLASSIFIED'}). ` +
    `CRITICAL: keep the SAME animal — identical breed, fur colour, markings and facial features so it is ` +
    `instantly recognisable — but give it an OBVIOUS in-character spy makeover that clearly differs from the ` +
    `original snapshot. Dress it in visible espionage wardrobe and add playful props: e.g. tiny dark sunglasses, ` +
    `a miniature tuxedo / trench coat / suit collar, a covert earpiece, and one signature gadget. ` +
    `Place it in a cinematic scene themed around its operations hub "${analysis.opHub || 'a secret HQ'}", with ` +
    `dramatic spy-movie lighting, moody rim light, shallow depth of field and a rich bokeh background. ` +
    `Mood: ${analysis.vibe || 'cool and stealthy'}. Photorealistic, ultra-detailed, 4k, warm cinematic colour ` +
    `grade, 1:1 square. No text, captions, logos or watermarks.${creativeDirection}`
  );
}

// Maps a raw AI/network error to friendly, in-character user copy. Shared by the
// analysis and portrait flows. A leading "BILLING_DEPLETED|" is handled specially
// by the banner UI (shows a top-up link and stays until dismissed).
function mapAiError(err: any): string {
  const errStr = JSON.stringify(err)?.toLowerCase() || '';
  const msg = (err?.message || err?.status || '').toString().toLowerCase();

  if (msg.includes('prepayment') || msg.includes('prepay') || msg.includes('depleted') || msg.includes('exhausted') || msg.includes('billing') || errStr.includes('prepayment') || errStr.includes('prepay') || errStr.includes('depleted') || errStr.includes('exhausted') || errStr.includes('billing') || errStr.includes('429') || errStr.includes('resource_exhausted')) {
    return 'BILLING_DEPLETED|Your prepayment credits are depleted in Google AI Studio. Please visit the billing panel to manage your project prepayment to continue.';
  } else if (msg.includes('quota') || errStr.includes('quota')) {
    return 'PAW LIMIT REACHED: The AI is busy eating treats. Come back tomorrow!';
  } else if (msg.includes('safety') || msg.includes('block') || errStr.includes('safety') || errStr.includes('block')) {
    return 'TOP SECRET: This pet is too cool for our spy filters. Try another photo!';
  } else if (msg.includes('fetch') || msg.includes('network') || errStr.includes('fetch') || errStr.includes('network')) {
    return 'WIFI INTERRUPTED: Please check your connection and try again!';
  } else if (msg.includes('format') || msg.includes('mime') || errStr.includes('format') || errStr.includes('mime')) {
    return 'NOT A PHOTO: Please select a clear picture of your pet!';
  } else if (msg.includes('timeout') || errStr.includes('timeout')) {
    return 'TOO SLOW: Your pet\'s file is incredibly secretive! Please try again.';
  }
  return 'Oops! The AI needs a nap. Try scanning your pet again in a moment.';
}

// html-to-image filter: excludes any node marked data-capture-exclude="true" from
// downloaded/shared poster captures — used to keep the "tap to reveal" overlay out
// of the actual downloaded image when a user downloads before revealing the portrait.
function excludeCaptureOverlay(node: HTMLElement) {
  return node?.dataset?.captureExclude !== 'true';
}

// Attaches a fresh Firebase ID token to every API call. The server now verifies
// this on /api/analyze-pet, /api/generate-pet-image and /api/notify-creator and
// enforces quota itself — the client is no longer a trusted source of truth.
async function apiFetch(path: string, user: FirebaseUser, body: unknown): Promise<Response> {
  const idToken = await user.getIdToken();
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify(body)
  });
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const isTestAccount = !!(user?.email && TEST_ACCOUNT_EMAILS.includes(user.email.toLowerCase()));

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [hasNewPhoto, setHasNewPhoto] = useState<boolean>(false);
  const [result, setResult] = useState<SavedGeneration['result'] | null>(null);
  const [genImage, setGenImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [isTermsOpen, setIsTermsOpen] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [petName, setPetName] = useState<string>('');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('English');
  const [currentTokenUsage, setCurrentTokenUsage] = useState<SavedGeneration['tokenUsage'] | null>(null);
  
  // Past Generations
  const [pastGenerations, setPastGenerations] = useState<SavedGeneration[]>([]);
  // Id of the dossier currently on screen, so an opt-in portrait can be merged
  // back into the right saved-history entry after it's generated.
  const [currentGenId, setCurrentGenId] = useState<string | null>(null);
  
  // Validation / Error States
  const [showNameError, setShowNameError] = useState(false);
  const [showPhotoError, setShowPhotoError] = useState(false);
  const [bureauError, setBureauError] = useState<string | null>(null);

  // Quota request custom states
  const [requestedQuotaVal, setRequestedQuotaVal] = useState<number>(5);
  const [isSubmittingQuota, setIsSubmittingQuota] = useState(false);
  const [quotaMessage, setQuotaMessage] = useState<string | null>(null);

  // Sharing Dialog States
  const [shareDialog, setShareDialog] = useState<{
    isOpen: boolean;
    platform: 'instagram' | 'linkedin' | 'whatsapp' | null;
    elementRef: React.RefObject<HTMLDivElement | null> | null;
    defaultFileName: string;
    bgColor: string;
  }>({
    isOpen: false,
    platform: null,
    elementRef: null,
    defaultFileName: '',
    bgColor: '#ffffff'
  });
  const [copiedCaptionState, setCopiedCaptionState] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const posterRef = useRef<HTMLDivElement>(null);

  // Listen to Auth changes and sync profile
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          const profile = await getOrCreateUserProfile(currentUser);
          setUserProfile(profile);
        } catch (e) {
          console.error("Could not fetch user profile details", e);
        }
      } else {
        setUserProfile(null);
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Dynamic initialization of Google Analytics 4 (GA4)
  useEffect(() => {
    const gaId = (import.meta as any).env?.VITE_GA_MEASUREMENT_ID;
    if (!gaId) {
      console.log("[Analytics Bureau] VITE_GA_MEASUREMENT_ID not set in environment secrets. Standby mode.");
      return;
    }

    console.log(`[Analytics Bureau] Initializing GA4 with Measurement ID: ${gaId}`);

    // Create and inject the gtag.js script safely
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
    document.head.appendChild(script);

    // Initialize dataLayer and gtag
    const win = window as any;
    win.dataLayer = win.dataLayer || [];
    function gtag(...args: any[]) {
      win.dataLayer.push(args);
    }
    win.gtag = gtag;

    gtag('js', new Date());
    gtag('config', gaId, {
      send_page_view: true,
      cookie_flags: 'SameSite=None;Secure' // Required because we render in a sandbox iframe
    });
  }, []);

  // Load generations from local storage and prune any entries older than 7 days
  useEffect(() => {
    const saved = localStorage.getItem('pawstories_generations') || localStorage.getItem('impawster_generations');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SavedGeneration[];
        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        
        // Filter out items older than 7 days (fallback to current time if no timestamp)
        const valid = parsed.filter(gen => {
          const timestamp = gen.timestamp || now;
          return now - timestamp <= sevenDaysMs;
        });

        setPastGenerations(valid);
        
        if (valid.length !== parsed.length) {
          try {
            localStorage.setItem('pawstories_generations', JSON.stringify(valid));
          } catch (err) {
            console.warn("Could not save pruned history to localStorage", err);
          }
        }
      } catch (e) {
        console.error("Failed to parse saved generations", e);
      }
    }
  }, []);

  const saveGeneration = (newGen: SavedGeneration) => {
    // Keep a maximum of 20 items to protect localStorage, while saving history for up to 7 days
    let updated = [newGen, ...pastGenerations].slice(0, 20);
    setPastGenerations(updated);
    try {
      localStorage.setItem('pawstories_generations', JSON.stringify(updated));
    } catch (e: any) {
      console.warn("Storage quota exceeded, trying to prune older history:", e);
      while (updated.length > 1) {
        updated = updated.slice(0, updated.length - 1);
        try {
          localStorage.setItem('pawstories_generations', JSON.stringify(updated));
          setPastGenerations(updated);
          break;
        } catch (innerErr) {
          // keep pruning
        }
      }
    }
  };

  // Merge a partial update into a saved-history entry and re-persist it.
  const updateSavedGen = (id: string, patch: Partial<SavedGeneration>) => {
    setPastGenerations((prev: SavedGeneration[]) => {
      const updated = prev.map((g: SavedGeneration) => (g.id === id ? { ...g, ...patch } : g));
      try {
        localStorage.setItem('pawstories_generations', JSON.stringify(updated));
      } catch (e) {
        // Non-fatal: keep the in-memory update even if localStorage is full.
        console.warn('Could not persist updated generation to localStorage', e);
      }
      return updated;
    });
  };

  const loadSavedGen = (gen: SavedGeneration) => {
    setPetName(gen.name);
    setPreview(gen.preview);
    setHasNewPhoto(false);
    setGenImage(gen.genImage);
    setResult(gen.result);
    setSelectedLanguage(gen.language);
    setCurrentGenId(gen.id);
    if (gen.tokenUsage) {
      setCurrentTokenUsage(gen.tokenUsage);
    } else {
      setCurrentTokenUsage(null);
    }
  };

  const resetToHome = () => {
    setFile(null);
    setPreview(null);
    setHasNewPhoto(false);
    setResult(null);
    setGenImage(null);
    setPetName('');
    setIsAnalyzing(false);
    setIsGeneratingImage(false);
    setStatus('');
    setBureauError(null);
    setQuotaMessage(null);
    setCurrentTokenUsage(null);
    setCurrentGenId(null);
  };

  const devReset = () => {
    setFile(null);
    setPreview(null);
    setHasNewPhoto(false);
    setResult(null);
    setGenImage(null);
    setPetName('');
    setIsAnalyzing(false);
    setIsGeneratingImage(false);
    setStatus('');
    setBureauError(null);
    setCurrentTokenUsage(null);
    setCurrentGenId(null);
  };

  const deleteSavedGen = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = pastGenerations.filter(g => g.id !== id);
    setPastGenerations(updated);
    try {
      localStorage.setItem('pawstories_generations', JSON.stringify(updated));
    } catch (err) {
      console.error("Failed to delete from localStorage", err);
    }
  };

  const downloadElementAsImage = async (
    elementRef: React.RefObject<HTMLDivElement | null>, 
    fileName: string, 
    fallbackBgColor = '#ffffff'
  ) => {
    if (elementRef.current === null) return;
    try {
      const element = elementRef.current;
      const isJpeg = fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg');
      
      // Explicitly providing width and height and removing transform fixes cropping issues
      const options = {
        cacheBust: true,
        backgroundColor: fallbackBgColor,
        pixelRatio: 2,
        width: element.offsetWidth,
        height: element.offsetHeight,
        filter: excludeCaptureOverlay,
        style: {
          transform: 'none',
          margin: '0'
        }
      };
      
      const dataUrl = isJpeg
        ? await (await import("html-to-image")).toJpeg(element, { ...options, quality: 0.95 })
        : await (await import("html-to-image")).toPng(element, options);
      
      const link = document.createElement('a');
      link.download = fileName;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Failed to download element:', err);
    }
  };

  const openShareDialog = async (
    platform: 'instagram' | 'linkedin' | 'whatsapp',
    ref: React.RefObject<HTMLDivElement | null>,
    fileName: string,
    bgColor: string
  ) => {
    if (!result) return;
    const caption = `My pet ${petName} is actually an undercover agent: "${result.identity}"! 🕵️‍♂️ Special Power: ${result.talent}. Check your pet what its secret life is like: ${window.location.origin} 🐾 #PetIntel`;
    
    // Attempt native OS share first
    if (navigator.share) {
      try {
        let fileObj = null;
        if (ref.current) {
          const { toJpeg } = await import('html-to-image');
          const dataUrl = await toJpeg(ref.current, { cacheBust: true, backgroundColor: bgColor, pixelRatio: 2, quality: 0.95, width: ref.current.offsetWidth, height: ref.current.offsetHeight, filter: excludeCaptureOverlay, style: { transform: 'none', margin: '0' } });
          const blob = await (await fetch(dataUrl)).blob();
          fileObj = new File([blob], fileName, { type: 'image/jpeg' });
        }
        
        if (fileObj && navigator.canShare && navigator.canShare({ files: [fileObj] })) {
          await navigator.share({
            title: 'Pawstories Secret Agent',
            text: caption,
            files: [fileObj]
          });
          return; // Shared natively successfully
        } else {
          await navigator.share({
            title: 'Pawstories Secret Agent',
            text: caption
          });
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return; // User cancelled the share, do not show fallback dialog
        }
        console.error('Native share failed:', err);
      }
    }

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(caption);
        setCopiedCaptionState(true);
        setTimeout(() => setCopiedCaptionState(false), 3000);
      }
    } catch (err) {
      console.error('Could not copy text: ', err);
    }
    setShareDialog({
      isOpen: true,
      platform,
      elementRef: ref,
      defaultFileName: fileName,
      bgColor
    });
    // Run automatic image download for the user's convenience!
    await downloadElementAsImage(ref, fileName, bgColor);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isTestAccount && (userProfile?.generationCount ?? 0) >= 3) {
      setBureauError('PAW LIMIT REACHED: You cannot upload new suspect photos. Please wait until new credits are credited!');
      return;
    }
    let f = e.target.files?.[0];
    if (f) {
      const fileName = f.name.toLowerCase();
      const isHeic = fileName.endsWith('.heic') || fileName.endsWith('.heif') || f.type === 'image/heic' || f.type === 'image/heif';
      const isSvg = fileName.endsWith('.svg') || f.type === 'image/svg+xml';
      if ((!f.type || !f.type.startsWith('image/')) && !isHeic && !isSvg) {
        setBureauError('INVALID PHOTO: Please select a valid image file.');
        return;
      }
      if (f.size > 15 * 1024 * 1024) { // 15MB limit
        setBureauError('FILE TOO LARGE: Max file size is 15MB.');
        return;
      }

      try {
        setIsAnalyzing(true);
        setIsGeneratingImage(false);
        setStatus('Optimizing photo format...');

        if (isHeic) {
          const converted = (await (await import('heic2any')).default)({ blob: f, toType: 'image/jpeg', quality: 0.85 });
          f = new File([Array.isArray(converted) ? converted[0] : converted], f.name.replace(/.heic$|.heif$/i, '.jpg'), { type: 'image/jpeg' });
        }

        const normalizedFile = await new Promise<File>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Failed to read image file.'));
          reader.onloadend = async () => {
            try {
              const base64Result = reader.result as string;
              const normalizedBase64 = await shrinkBase64Image(base64Result, PREVIEW_MAX_DIM, PREVIEW_QUALITY);
              const response = await fetch(normalizedBase64);
              const blob = await response.blob();
              resolve(new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
            } catch (error) {
              reject(error instanceof Error ? error : new Error('Failed to process image format.'));
            }
          };
          reader.readAsDataURL(f);
        });

        setFile(normalizedFile);
        const normalizedReader = new FileReader();
        normalizedReader.onloadend = () => {
          setPreview(normalizedReader.result as string);
          setHasNewPhoto(true);
          setBureauError(null);
          setResult(null);
          setGenImage(null);
          setIsAnalyzing(false);
          setStatus('');
        };
        normalizedReader.onerror = () => {
          setIsAnalyzing(false);
          setStatus('');
          setBureauError('Failed to process image format. Please try another photo.');
        };
        normalizedReader.readAsDataURL(normalizedFile);
      } catch (err) {
        console.error('Image conversion error:', err);
        setIsAnalyzing(false);
        setStatus('');
        setBureauError(err instanceof Error ? err.message : 'Failed to process image format. Please try another photo.');
        return;
      }
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setAuthLoading(true);
      await loginWithGoogle();
    } catch (e: any) {
      if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cross-origin-opener-policy-failed' || String(e).toLowerCase().includes('popup')) {
        setBureauError("GOOGLE SIGN IN FAILED: The popup was blocked. Please open this app in a NEW TAB using the ↗ icon in the top right, then try again.");
      } else {
        setBureauError("GOOGLE SIGN IN FAILED: " + (e?.message || "Please check your connection and try again."));
      }
      setTimeout(() => setBureauError(null), 8000);
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      // Optimistically clear all local session states instantly for maximum responsiveness in the iframe
      setUser(null);
      setUserProfile(null);
      devReset();
      
      // Perform the background signOut
      await logoutUser();
    } catch (e) {
      console.error("Error during background sign out:", e);
    }
  };

  const handleSendQuotaEmail = async () => {
    if (!user) return;
    setIsSubmittingQuota(true);
    setQuotaMessage(null);
    try {
      // 1. Submit Request to Firestore as historical record
      await submitQuotaRequest(user.uid, user.email || '', requestedQuotaVal);
      
      // 2. Trigger secure mail notify from backend
      const response = await apiFetch('/api/notify-creator', user, {
        userId: user.uid,
        email: user.email || '',
        displayName: user.displayName || 'Anonymous Agent',
        requestedAmount: requestedQuotaVal
      });

      // Update local profile state
      setUserProfile(prev => prev ? { ...prev, requestStatus: 'requested', requestedAmount: requestedQuotaVal } : null);
      
      if (response.ok) {
        setQuotaMessage("✓ Notification Sent! The creator has been notified of your quota request.");
      } else {
        setQuotaMessage("✓ Request logged in database!");
      }
    } catch (err) {
      console.error(err);
      // Fallback: request was still logged in firestore, so transition state gracefully
      setUserProfile(prev => prev ? { ...prev, requestStatus: 'requested', requestedAmount: requestedQuotaVal } : null);
      setQuotaMessage("✓ Request logged in database!");
    } finally {
      setIsSubmittingQuota(false);
    }
  };

  const analyzePet = async () => {
    if (isAnalyzing || isGeneratingImage) {
      setBureauError('Please wait for the current analysis to finish before starting another one.');
      return;
    }

    if (!user) {
      setBureauError('SIGN IN REQUIRED: Please log in using Google OAuth.');
      return;
    }

    if (!isTestAccount && (userProfile?.generationCount ?? 0) >= 3) {
      setBureauError('PAW LIMIT REACHED: You can only generate up to 3 spy files. Please request extra quota below!');
      return;
    }

    if (result && !hasNewPhoto) {
      setBureauError('NEW PHOTO REQUIRED: Please select or upload a NEW pet photo above!');
      setShowPhotoError(true);
      setTimeout(() => setShowPhotoError(false), 3000);
      return;
    }

    let hasError = false;
    if (!petName.trim()) {
      setShowNameError(true);
      hasError = true;
    }
    if (!preview) {
      setShowPhotoError(true);
      hasError = true;
    }

    if (hasError) {
      setTimeout(() => {
        setShowNameError(false);
        setShowPhotoError(false);
      }, 3000);
      return;
    }

    setBureauError(null);
    setIsAnalyzing(true);
    setResult(null);
    setGenImage(null);

    try {
      if (!preview) return;
      const base64Data = preview.split(',')[1];
      if (!base64Data) throw new Error('Invalid image data. Please try another photo.');
      const mimeType = 'image/jpeg';

      // Cheap satirical analysis + human/invalid gate. The expensive image portrait
      // is now opt-in (see generateSpyImage), so we no longer pay for image
      // generation on every reveal — this is the primary cost lever.
      setStatus('Securing bio-scanners...');
      logClient('analysis.start', { language: selectedLanguage });
      const analysisPrompt = `You are a strict pet-photo moderator and satirical spy analyst.
STEP 1 — SAFETY CHECK (do this before anything else, it overrides every other instruction): look at the image and decide whether its MAIN SUBJECT is a real animal/pet (dog, cat, bird, hamster, rabbit, reptile, fish, horse, guinea pig, ferret, turtle, lizard, farm animal, or other household pet) or not. Return the rejection below if the main subject is a human being — a selfie, a portrait, a person's face or body, a group photo of people — or if there is no clear animal subject at all. A human hand, arm, leg, or person incidentally holding, petting, or standing near the animal is fine and still counts as valid, AS LONG AS an animal is the clear main subject of the photo. If the image fails this check, respond with EXACTLY this JSON and nothing else: {"errorType":"HUMAN_OR_INVALID"}
STEP 2 — Only if STEP 1 passed, return only one compact JSON object in "${selectedLanguage}" with exactly these 10 keys: identity, codeId, vibe, opHub, desc, talent, nemesis, zoomies, heist, imagePrompt. Use short values. desc must be one short sentence under 110 chars. imagePrompt must be a vivid one-sentence English description of THIS pet dressed as a secret agent — name a specific spy costume, a signature prop/gadget, and a themed scene that matches opHub.
Never skip STEP 1. Do not add comments, markdown, or extra text.`;

      const response = await apiFetch('/api/analyze-pet', user, { base64Data, mimeType, analysisPrompt, language: selectedLanguage });
      const analysisResponse = await response.json();

      if (!response.ok) {
        // 401/429 carry specific, already-friendly copy from the server's own
        // auth/quota checks — show those directly rather than losing the
        // specifics through the generic mapAiError heuristics below.
        if (response.status === 401 || response.status === 429) {
          logClient('analysis.rejected', { reason: response.status === 429 ? 'quota' : 'auth', status: response.status });
          setBureauError(analysisResponse.error || 'Please sign in and try again.');
          setIsAnalyzing(false);
          setStatus('');
          return;
        }
        throw new Error(analysisResponse.error || 'Failed to analyze pet');
      }
      if (!analysisResponse || !analysisResponse.text) {
        throw new Error('Analysis response was empty.');
      }
      if (analysisResponse?.costEstimate) {
        logClient('analysis.cost', analysisResponse.costEstimate);
      }

      let analysis;
      try {
        const cleanText = analysisResponse.text.replace(/```json\n?|```/g, '').trim();
        analysis = JSON.parse(cleanText);
      } catch (parseErr) {
        throw new Error('Identity data corrupt. Let\'s try investigating again!');
      }

      // Human/invalid gate — reject before counting quota or offering a portrait.
      if (analysis.errorType === 'HUMAN_OR_INVALID') {
        logClient('analysis.rejected', { reason: 'human_or_invalid' });
        setBureauError(HUMAN_REJECT_MESSAGE);
        setIsAnalyzing(false);
        setStatus('');
        return;
      }

      // Token accounting — text only for now; image tokens are merged in later if
      // the user opts to generate a portrait.
      const textTokens = analysisResponse.usageMetadata ? {
        prompt: analysisResponse.usageMetadata.promptTokenCount || 0,
        candidates: analysisResponse.usageMetadata.candidatesTokenCount || 0,
        total: analysisResponse.usageMetadata.totalTokenCount || 0
      } : { prompt: 0, candidates: 0, total: 0 };

      const usageData = {
        textTokens,
        imageTokens: { prompt: 0, candidates: 0, total: 0 },
        combinedTotal: textTokens.total
      };

      setResult(analysis);
      setCurrentTokenUsage(usageData);
      setStatus('');

      // The server already checked and incremented quota BEFORE running the AI
      // call (see checkAndIncrementQuota in server.ts) — sync the authoritative
      // count it returns instead of trusting/mutating our own local guess.
      if (analysisResponse.quota) {
        setUserProfile((prev: UserProfile | null) => prev
          ? { ...prev, generationCount: analysisResponse.quota.generationCount }
          : prev);
      }
      setHasNewPhoto(false);
      logClient('analysis.done', {
        totalTokens: textTokens.total,
        estimatedUsd: analysisResponse?.costEstimate?.estimatedUsdFormatted
      });

      const win = window as any;
      if (win.gtag) {
        win.gtag('event', 'dossier_generated', {
          pet_name: petName,
          language: selectedLanguage,
          text_total_tokens: textTokens.total
        });
      }

      // Persist to local history immediately (no image yet). generateSpyImage will
      // merge the portrait into this same entry by id.
      const genId = Math.random().toString(36).substring(2, 9);
      setCurrentGenId(genId);
      const shrunkPreview = preview ? await shrinkBase64Image(preview, 400, 0.6) : '';
      const newGen: SavedGeneration = {
        id: genId,
        name: petName,
        preview: shrunkPreview,
        genImage: null,
        result: analysis,
        language: selectedLanguage,
        timestamp: Date.now(),
        tokenUsage: usageData
      };
      saveGeneration(newGen);

    } catch (err: any) {
      logClient('analysis.error', { message: err?.message });
      const errorMsg = mapAiError(err);
      setBureauError(errorMsg);
      if (!errorMsg.startsWith('BILLING_DEPLETED')) {
        setTimeout(() => setBureauError(null), 8000);
      }
    } finally {
      setIsAnalyzing(false);
      setStatus('');
    }
  };

  // Opt-in AI spy portrait. Kept separate from analyzePet so image generation —
  // by far the most expensive call — only fires when the user explicitly asks for
  // it. Does NOT consume additional quota (the dossier already did).
  const generateSpyImage = async () => {
    if (!result || !preview) return;
    if (isAnalyzing || isGeneratingImage || genImage) return;

    if (!user) {
      setBureauError('SIGN IN REQUIRED: Please log in using Google OAuth.');
      return;
    }

    const base64Data = preview.split(',')[1];
    if (!base64Data) {
      setBureauError('Invalid image data. Please try another photo.');
      return;
    }
    const mimeType = 'image/jpeg';

    setBureauError(null);
    setIsGeneratingImage(true);
    setStatus('Composing digital evidence...');
    logClient('portrait.start', { genId: currentGenId });

    try {
      const imagePrompt = buildImagePrompt(petName, result);
      const response = await apiFetch('/api/generate-pet-image', user, { base64Data, mimeType, imagePrompt });
      const imageResponse = await response.json();

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          logClient('portrait.rejected', { status: response.status });
          setBureauError(imageResponse.error || 'Please sign in and try again.');
          setIsGeneratingImage(false);
          setStatus('');
          return;
        }
        throw new Error(imageResponse.error || 'Failed to generate image');
      }

      const finalGenImage: string | null = imageResponse.image || null;
      if (!finalGenImage) {
        throw new Error('The image lab came back empty. Please try again.');
      }
      setGenImage(finalGenImage);

      if (imageResponse?.costEstimate) {
        logClient('portrait.cost', imageResponse.costEstimate);
      }

      const imageTokens = imageResponse?.usageMetadata ? {
        prompt: imageResponse.usageMetadata.promptTokenCount || 0,
        candidates: imageResponse.usageMetadata.candidatesTokenCount || 0,
        total: imageResponse.usageMetadata.totalTokenCount || 0
      } : { prompt: 0, candidates: 0, total: 0 };

      const baseTextTokens = currentTokenUsage?.textTokens || { prompt: 0, candidates: 0, total: 0 };
      const mergedUsage = {
        textTokens: baseTextTokens,
        imageTokens,
        combinedTotal: baseTextTokens.total + imageTokens.total
      };
      setCurrentTokenUsage(mergedUsage);
      logClient('portrait.done', {
        totalTokens: imageTokens.total,
        estimatedUsd: imageResponse?.costEstimate?.estimatedUsdFormatted
      });

      const win = window as any;
      if (win.gtag) {
        win.gtag('event', 'portrait_generated', {
          pet_name: petName,
          image_total_tokens: imageTokens.total
        });
      }

      // Merge the portrait into the matching saved-history entry.
      if (currentGenId) {
        const shrunkGenImage = await shrinkBase64Image(finalGenImage, 500, 0.6);
        updateSavedGen(currentGenId, { genImage: shrunkGenImage, tokenUsage: mergedUsage });
      }
    } catch (err: any) {
      logClient('portrait.error', { message: err?.message });
      const errorMsg = mapAiError(err);
      setBureauError(errorMsg);
      if (!errorMsg.startsWith('BILLING_DEPLETED')) {
        setTimeout(() => setBureauError(null), 8000);
      }
    } finally {
      setIsGeneratingImage(false);
      setStatus('');
    }
  };

  // Remaining Runs calculator
  const generationsLeftCount = Math.max(0, 3 - (userProfile?.generationCount ?? 0));

  return (
    <div className="min-h-screen bg-[#090d16] text-[#f1f5f9] flex flex-col font-sans select-none antialiased">
      {/* Top Navbar */}
      <header className="border-b border-[#1e293b] bg-[#0c111d] px-4 py-2.5 flex flex-row items-center justify-between gap-2 sticky top-0 z-40 shadow-md">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 bg-[#ff821c] border border-black rounded-xl flex items-center justify-center shadow-md">
            <PawPrint className="text-black w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-sm sm:text-lg font-black italic tracking-tighter leading-none text-white uppercase flex items-center gap-1.5">
              PAWSTORIES.FUN <span className="text-[9px] bg-[#ff821c] text-black font-black px-1.5 py-0.5 rounded italic">SECURE</span>
            </h1>
            <p className="text-[8px] sm:text-[9.5px] font-black uppercase text-zinc-500 tracking-wider mt-0.5">Surveillance Bureau</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2.5">
          {user && (
            <div className="bg-[#121824] border border-[#1e293b] px-2.5 py-1.5 rounded-lg text-[9px] sm:text-xs font-black uppercase tracking-wider text-amber-400 flex items-center gap-1.5 shadow-inner">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isTestAccount || generationsLeftCount > 0 ? 'bg-[#ff821c]' : 'bg-red-500'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isTestAccount || generationsLeftCount > 0 ? 'bg-[#ff821c]' : 'bg-red-500'}`}></span>
              </span>
              <span>RUNS: {isTestAccount ? 'UNLIMITED 🐾' : `${generationsLeftCount}/3`}</span>
            </div>
          )}

          {user && (
            <>
              <a 
              href="mailto:hello@pawstories.fun"
              className="text-[9px] sm:text-xs bg-[#121824] text-zinc-300 border border-[#1e293b] hover:bg-[#1e293b] font-black tracking-wider uppercase px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shadow-inner"
            >
              <Mail className="w-3 h-3" /> Contact Us
            </a>
            <button 
              onClick={handleLogout}
              className="text-[9px] sm:text-xs bg-red-950/40 text-red-400 border border-red-900/50 hover:bg-red-900/30 font-black tracking-wider uppercase px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
            >
              <LogOut className="w-3 h-3" /> Sign Out
            </button>
            </>
          )}
        </div>
      </header>

      {/* Bureau Live Warning Banner */}
      {bureauError && (
        <div className="bg-red-500/10 border-b border-red-500/20 text-red-200 px-4 py-3 sm:py-4 relative flex items-center justify-center">
          <div className="max-w-3xl w-full flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-5.5 h-5.5 text-red-400 shrink-0" />
              <div className="text-xs sm:text-sm font-semibold leading-relaxed">
                {bureauError.startsWith('BILLING_DEPLETED|') ? (
                  <>
                    <strong className="text-red-400 font-black block sm:inline uppercase mr-1.5">GOOGLE BILLING EXHAUSTED (ERROR 429):</strong>
                    {bureauError.split('|')[1]}
                  </>
                ) : (
                  bureauError
                )}
              </div>
            </div>
            
            <div className="flex gap-2 shrink-0">
              {bureauError.startsWith('BILLING_DEPLETED|') && (
                <a 
                  href="https://ai.studio/projects" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="bg-[#ff821c] hover:bg-[#e07115] text-black text-[10px] sm:text-xs font-black uppercase px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all shadow-md"
                >
                  Top Up AI Studio 💳
                </a>
              )}
              <button 
                onClick={() => setBureauError(null)} 
                className="text-[10px] sm:text-xs font-bold text-zinc-400 hover:text-white uppercase px-2.5 py-1.5 bg-zinc-800/80 hover:bg-zinc-800 rounded-lg"
              >
                Dismiss ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Container Check */}
      {authLoading ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16">
          <Loader2 className="w-10 h-10 animate-spin text-[#ff821c]" />
          <p className="text-xs font-black uppercase tracking-[0.2em] text-zinc-500">Checking Security Clearance Credentials...</p>
        </div>
      ) : !user ? (
        /* --- Sign In Google OAuth Page Gate --- */
        <div className="flex-1 max-w-lg w-full mx-auto p-6 flex flex-col items-center justify-center my-auto space-y-8">
          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full bg-[#0c111a] border border-[#1e293b] rounded-[36px] p-8 text-center space-y-6 shadow-2xl relative overflow-hidden"
          >
            {/* Background elements */}
            <div className="absolute top-0 left-0 w-24 h-24 bg-[#ff821c]/5 rounded-full blur-2xl pointer-events-none" />
            <div className="absolute bottom-0 right-0 w-24 h-24 bg-red-500/5 rounded-full blur-2xl pointer-events-none" />

            <div className="relative w-24 h-24 mx-auto flex items-center justify-center bg-gradient-to-tr from-amber-400 to-[#ff821c] rounded-3xl shadow-lg border-2 border-black rotate-3 hover:rotate-0 transition-transform duration-300">
              <div className="animate-bounce duration-1000 mt-1">
                <PawPrint className="w-12 h-12 text-black" />
              </div>
              <div className="absolute -top-2 -right-2 bg-red-500 text-white border-2 border-black text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter rotate-12 flex items-center gap-0.5 shadow-md">
                <span>GOOFY</span>
                <span>🤪</span>
              </div>
              <div className="absolute -bottom-2 -left-2 bg-blue-500 text-white border-2 border-black text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter -rotate-12 flex items-center gap-0.5 shadow-md">
                <span>SPY</span>
                <span>🕵️‍♂️</span>
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-black tracking-tight text-white leading-snug uppercase">
                Do you know what your pets are doing when you are not looking? 🤔
              </h2>
              <span className="text-[10px] font-black uppercase text-[#ff821c] tracking-[0.2em] block">PAWSTORIES SPY REVEALER</span>
            </div>

            <p className="text-xs text-zinc-400 font-semibold leading-relaxed max-w-sm mx-auto">
              Welcome to <strong className="text-white font-black">pawstories.fun</strong>! Connect with Google to uncover your pet's classified undercover identity and print goofy agent dossiers.
            </p>

            <div className="pt-2">
              <button
                onClick={handleGoogleLogin}
                className="w-full bg-white hover:bg-zinc-150 text-black font-black uppercase px-6 py-4 rounded-2xl transition-all shadow-xl hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-3 border border-transparent text-xs"
              >
                {/* Embedded custom crisp SVGs for Google logo icon */}
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                  <path fill="#EA4335" d="M12.24 10.285V14.4h6.887c-.275 1.565-1.88 4.604-6.887 4.604-4.33 0-7.859-3.578-7.859-8s3.53-8 7.859-8c2.46 0 4.105 1.025 5.047 1.926l3.227-3.107C18.29 1.92 15.42 1 12.24 1 5.918 1 1 5.918 1 12s4.918 11 11.24 11c6.6 0 11-4.63 11-11.19 0-.75-.08-1.33-.19-1.815z" />
                </svg>
                <span>Log In with Google Account</span>
              </button>
              <p className="mt-4 text-[10px] text-zinc-500 font-bold tracking-wide">
                Having trouble logging in? <br className="sm:hidden" />
                <span className="text-zinc-400">Open the app in a new tab using the <strong className="text-white bg-zinc-800 px-1 py-0.5 rounded ml-0.5">↗</strong> icon above.</span>
              </p>
            </div>

            {/* Playful rules footers */}
            <div className="pt-4 border-t border-slate-900/85 text-[9px] text-zinc-500 uppercase font-bold tracking-wider space-y-1">
              <p>🕵️‍♂️ Instant Secure Verification</p>
              <p className="text-[#ff821c]/70">Strict Undercover Bureau Clearance Active</p>
            </div>
          </motion.div>
        </div>
      ) : (
        /* --- Authorized Application Dashboard Layout --- */
        <div className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
          <AnimatePresence mode="wait">
            {result ? (
              /* --- Poster Reveal View (Isolated single-column layout) --- */
              <motion.div
                key="result-view"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.35 }}
                className="max-w-xl mx-auto flex flex-col items-center gap-6"
              >
                {/* Document Canvas to Download */}
                <div 
                  ref={posterRef}
                  className="w-full max-w-sm bg-white border-[6px] border-[#121824] rounded-[24px] overflow-hidden p-5 relative shadow-2xl font-sans text-zinc-900 mx-auto"
                  style={{
                    backgroundImage: 'radial-gradient(#e2e8f0 1.5px, #ffffff 1.5px)',
                    backgroundSize: '16px 16px',
                  }}
                >
                  {/* Header Badge */}
                  <div className="border-b-2 border-dashed border-zinc-300 pb-2.5 mb-4 flex justify-between items-center text-zinc-500">
                    <span className="text-[10px] font-mono font-black tracking-widest uppercase">
                      AGENT ID: {result.codeId || 'CLASSIFIED'}
                    </span>
                    <span className="text-[8px] font-sans font-black bg-red-600 text-white px-2 py-0.5 rounded uppercase tracking-wider">
                      TOP SECRET
                    </span>
                  </div>

                  {/* Pet Photo Container */}
                  <div className="aspect-square w-full p-1.5 bg-zinc-50 border-4 border-black rounded-2xl relative shadow-[3px_3px_0px_#121824] overflow-hidden mb-4">
                    {isGeneratingImage ? (
                      <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-100 rounded-xl">
                        <Loader2 className="w-8 h-8 animate-spin text-zinc-400 mb-2" />
                        <span className="text-xs font-mono font-bold text-zinc-500 uppercase tracking-widest text-center px-4">
                          Synthesizing<br/>Digital Evidence...
                        </span>
                      </div>
                    ) : (
                      <img src={genImage || preview || ''} className="w-full h-full object-cover rounded-xl" />
                    )}

                    {/* Reveal overlay — the AI portrait is opt-in (image generation is the
                        expensive step), so until the user taps this, the photo stays as their
                        own upload. Placed directly on the photo since that's where a user's eye
                        already is, rather than a button buried below the whole dossier card.
                        data-capture-exclude keeps this out of downloaded/shared poster images. */}
                    {!genImage && !isGeneratingImage && (
                      <button
                        type="button"
                        onClick={generateSpyImage}
                        data-capture-exclude="true"
                        className="absolute inset-0 w-full h-full rounded-xl bg-black/60 hover:bg-black/70 active:bg-black/75 backdrop-blur-[1.5px] transition-all flex flex-col items-center justify-center gap-2 text-center px-5 group/reveal cursor-pointer"
                      >
                        <div className="w-12 h-12 bg-gradient-to-tr from-amber-400 to-[#ff821c] rounded-full flex items-center justify-center shadow-lg border-2 border-black group-hover/reveal:scale-110 group-active/reveal:scale-95 transition-transform">
                          <Stars className="w-5.5 h-5.5 text-black" />
                        </div>
                        <span className="text-white text-[13px] font-black uppercase tracking-wide leading-tight drop-shadow">
                          Reveal Secret Agent Photo
                        </span>
                        <span className="text-amber-300 text-[9px] font-black uppercase tracking-widest">
                          Tap to unmask 🕵️‍♂️
                        </span>
                      </button>
                    )}

                    {/* Inner labels on photo */}
                    <div className="absolute bottom-2 left-2 bg-yellow-400 border border-black text-[9px] font-black px-2 py-0.5 rounded shadow uppercase tracking-wide text-black">
                      VIBE: {result.vibe || 'CLASSIFIED'}
                    </div>
                    <div className="absolute top-2 right-2 bg-black text-white text-[8px] font-mono font-black px-1.5 py-0.5 rounded shadow uppercase">
                      HUB: {result.opHub}
                    </div>
                  </div>

                  {/* Quirky Bio Header */}
                  <div className="text-center mb-3">
                    <h3 className="text-xl font-black tracking-tight text-zinc-950 uppercase leading-none mb-1">
                      {petName}
                    </h3>
                    <div className="inline-block bg-amber-100 border border-black text-[11px] font-black uppercase py-0.5 px-2 rounded-lg shadow-[1.5px_1.5px_0px_#000] text-amber-900">
                      🕵️‍♂️ {result.identity}
                    </div>
                  </div>

                  {/* Description Text */}
                  <p className="text-xs font-semibold text-zinc-650 italic text-center leading-normal px-2 py-1.5 border-t border-b border-dashed border-zinc-200 mb-3.5">
                    "{result.desc}"
                  </p>

                  {/* Agency Mini stats */}
                  <div className="space-y-2 mb-4 text-xs font-bold text-left">
                    <div className="bg-zinc-50 border border-black p-2 rounded-xl flex items-center gap-2">
                      <span className="text-sm shrink-0">⚡</span>
                      <div>
                        <span className="text-[7.5px] font-black text-zinc-400 block leading-none uppercase">SECRET WEAPON</span>
                        <span className="text-zinc-900 leading-tight UPPERCASE font-black text-[11px] block">{result.talent}</span>
                      </div>
                    </div>

                    <div className="bg-zinc-50 border border-black p-2 rounded-xl flex items-center gap-2">
                      <span className="text-sm shrink-0">🎯</span>
                      <div>
                        <span className="text-[7.5px] font-black text-zinc-400 block leading-none uppercase">ARCH-RIVAL</span>
                        <span className="text-red-700 leading-tight UPPERCASE font-black text-[11px] block">{result.nemesis}</span>
                      </div>
                    </div>

                    <div className="bg-zinc-50 border border-black p-2 rounded-xl flex items-center gap-2">
                      <span className="text-sm shrink-0">🚀</span>
                      <div>
                        <span className="text-[7.5px] font-black text-zinc-400 block leading-none uppercase">ZOOMIES TRIGGER</span>
                        <span className="text-zinc-900 leading-tight UPPERCASE font-black text-[11px] block">{result.zoomies}</span>
                      </div>
                    </div>

                    <div className="bg-zinc-50 border border-black p-2 rounded-xl flex items-center gap-2">
                      <span className="text-sm shrink-0">🍪</span>
                      <div>
                        <span className="text-[7.5px] font-black text-zinc-400 block leading-none uppercase">LATEST SUCCESSFUL HEIST</span>
                        <span className="text-zinc-900 leading-tight UPPERCASE font-black text-[11px] block">{result.heist}</span>
                      </div>
                    </div>
                  </div>

                  {/* Tiny Verified Footer Banner */}
                  <div className="text-center pt-2 border-t border-zinc-200 flex justify-between items-center text-[8px] font-mono font-black text-[#52525b]">
                    <span>CLASSIFIED AGENT FILE</span>
                    <span className="text-green-600">✓ PAWSTORIES DOSSIER VERIFIED</span>
                  </div>
                </div>

                {/* Poster Action Buttons */}
                <div className="flex flex-wrap justify-center gap-3 text-xs font-black uppercase text-white mt-2">
                  <button
                    onClick={() => downloadElementAsImage(posterRef, `${petName}-poster.jpg`, '#ffffff')}
                    className="bg-[#ff821c] text-black border-2 border-transparent px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 font-black shadow-lg shadow-[#ff821c]/10"
                  >
                    <Download className="w-4 h-4" /> Download JPG
                  </button>
                  <button 
                    onClick={() => openShareDialog('instagram', posterRef, `${petName}-poster.jpg`, '#ffffff')}
                    className="bg-[#e1306c] text-white border border-transparent px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 font-black shadow-lg"
                  >
                    <Instagram className="w-4 h-4 text-white" /> Instagram
                  </button>
                  <button 
                    onClick={() => openShareDialog('linkedin', posterRef, `${petName}-poster.jpg`, '#ffffff')}
                    className="bg-[#0077b5] text-white border border-transparent px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 font-black shadow-lg"
                  >
                    <Linkedin className="w-4 h-4 text-white" /> LinkedIn
                  </button>
                  <button 
                    onClick={() => openShareDialog('whatsapp', posterRef, `${petName}-poster.jpg`, '#ffffff')}
                    className="bg-[#25d366] text-white border border-transparent px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2 font-black shadow-lg"
                  >
                    <Share2 className="w-4 h-4 text-white" /> WhatsApp
                  </button>
                </div>

                {/* Redirect Button to check another secret life */}
                <button
                  onClick={resetToHome}
                  className="mt-6 bg-[#ff821c] hover:bg-[#e07115] text-black hover:scale-[1.02] active:scale-[0.98] transition-all px-8 py-3.5 rounded-2xl flex items-center gap-2 font-black text-xs uppercase tracking-widest shadow-lg shadow-[#ff821c]/15"
                >
                  <RefreshCcw className="w-4 h-4" /> Check Another Secret Life 🐾
                </button>
              </motion.div>
            ) : (
              /* --- Centered workspace card --- */
              <motion.div 
                key="home-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="max-w-xl mx-auto w-full"
              >
                {/* Centered Inputs & Action Card */}
                <div className="w-full bg-[#0c111a] border border-[#1e293b] rounded-[32px] p-6 space-y-6 shadow-2xl relative">
                  {/* Active actual user status banner */}
                  <div className="bg-[#121a2a] border border-blue-900/30 p-4 rounded-2xl flex items-center gap-3 relative overflow-hidden">
                    {user.photoURL ? (
                      <img src={user.photoURL} className="w-10 h-10 rounded-xl border border-[#ff821c]/30 shadow object-cover" />
                    ) : (
                      <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center">
                        <ShieldCheck className="w-5 h-5 text-blue-400" />
                      </div>
                    )}
                    <div className="overflow-hidden flex-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-[#ff821c] block">Verified Agent Profile</span>
                      <span className="text-xs font-black text-white block truncate">{user.displayName || 'Anonymous'}</span>
                      <span className="text-[10px] font-semibold text-zinc-400 block truncate">{user.email}</span>
                    </div>
                  </div>

                  {/* Block Input area if quota runs are depleted */}
                  {!isTestAccount && generationsLeftCount <= 0 ? (
                    <div className="bg-red-950/20 border border-red-500/30 p-5 rounded-[24px] space-y-5">
                      <div className="flex items-start gap-3">
                        <div className="p-2 bg-red-400/10 rounded-lg shrink-0 text-red-400">
                          <ShieldAlert className="w-5 h-5 animate-pulse" />
                        </div>
                        <div>
                          <h3 className="text-sm font-black text-white uppercase tracking-tight">Agent Runs Exhausted 🕵️‍♂️</h3>
                          <p className="text-[10px] text-zinc-400 uppercase mt-0.5 font-semibold">Maximum limit of 3 free spy files reached!</p>
                        </div>
                      </div>

                      <div className="space-y-3.5 bg-[#090d16] p-4 rounded-xl border border-red-500/10 text-xs text-center">
                        <p className="text-[#ff821c] font-black uppercase text-[10px] tracking-wider">🔒 Direct Uploads & Analyses Locked</p>
                        <p className="text-zinc-300 font-medium leading-relaxed">
                          To maintain optimized performance and reduce operating costs, this account has completed its allocated 3 investigator scans.
                        </p>
                        <div className="bg-amber-500/15 border border-amber-500/30 text-amber-500 p-3.5 rounded-lg leading-normal uppercase font-black text-[9.5px] tracking-wider">
                          🐾 Request additional credits to be credited to your agent badge!
                        </div>
                        
                        <div className="border-t border-slate-800/80 my-3.5 pt-3.5 text-left">
                          <p className="text-zinc-400 text-[10px] leading-relaxed uppercase font-semibold text-center mb-3">
                            Need urgent clearance for a pet? Notify the bureau creator to top up:
                          </p>
                          
                          <div className="space-y-1.5 pt-1 mb-3">
                            <label className="text-[8.5px] font-black uppercase text-zinc-400 tracking-wider">Extra Runs Requested</label>
                            <div className="flex gap-2">
                              <input 
                                type="number" 
                                min="1" 
                                max="50"
                                value={requestedQuotaVal}
                                onChange={(e) => setRequestedQuotaVal(parseInt(e.target.value) || 5)}
                                className="w-20 bg-[#121a2c] border border-slate-700 rounded-lg px-3 py-1.5 text-white font-bold font-mono focus:outline-none text-xs"
                              />
                              <span className="text-[10px] text-zinc-500 font-bold uppercase self-center">runs</span>
                            </div>
                          </div>

                          {userProfile?.requestStatus === 'requested' ? (
                            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3.5 text-xs text-green-400 uppercase font-black tracking-wide text-center space-y-1">
                              <p>✓ Notification Sent!</p>
                              <p className="text-[10px] text-zinc-300 normal-case font-bold">The creator has been notified of your request for {userProfile.requestedAmount || requestedQuotaVal} runs.</p>
                            </div>
                          ) : (
                            <button
                              onClick={handleSendQuotaEmail}
                              disabled={isSubmittingQuota}
                              className="w-full bg-[#ff821c] hover:bg-[#e07115] text-black font-black uppercase text-[10.5px] tracking-wider py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                            >
                              {isSubmittingQuota ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  <span>Notifying Creator...</span>
                                </>
                              ) : (
                                <>
                                  <Mail className="w-3.5 h-3.5" />
                                  <span>Notify Creator 🚀</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      {quotaMessage && (
                        <div className="bg-green-950/40 border border-green-800/40 text-green-400 text-[10px] p-3 rounded-lg leading-normal uppercase font-bold text-center">
                          {quotaMessage}
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Core interactive input form */
                    <>
                      {/* Photo Drop Area */}
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-wider block mb-2 text-zinc-400 font-bold">
                          Upload Suspect's Photo (Pets Only!)
                        </span>
                        <div 
                          onClick={() => fileInputRef.current?.click()}
                          className={`aspect-video w-full bg-[#111622] border-2 border-dashed rounded-2xl cursor-pointer relative overflow-hidden group transition-all active:scale-[0.98] flex flex-col items-center justify-center p-4 text-center ${
                            showPhotoError ? 'border-red-500' : 'border-[#1e293b] hover:border-[#ff821c]'
                          }`}
                        >
                          <AnimatePresence mode="wait">
                            {preview ? (
                              <motion.div key="preview" className="relative w-full h-full">
                                <img src={preview} className="w-full h-full object-cover rounded-xl" />
                                {isAnalyzing && (
                                  <div className="absolute inset-0 bg-black/60 rounded-xl flex items-center justify-center flex-col z-10">
                                    <Radar className="w-10 h-10 text-[#ff821c] animate-spin mb-2" />
                                    <span className="text-[#ff821c] text-[10px] font-black uppercase tracking-wider animate-pulse">Running Scans...</span>
                                  </div>
                                )}
                                {!isAnalyzing && (
                                  <button className="absolute bottom-3 right-3 bg-black/80 hover:bg-zinc-900 border border-zinc-700 text-[10px] font-black text-white px-3 py-1.5 rounded-lg flex items-center gap-1 uppercase tracking-widest z-20">
                                    <Camera className="w-3 h-3" /> Replace
                                  </button>
                                )}
                              </motion.div>
                            ) : (
                              <div key="placeholder" className="py-6 flex flex-col items-center">
                                <div className="w-12 h-12 bg-[#ff821c]/10 rounded-xl flex items-center justify-center mb-3">
                                  <Upload className="w-5 h-5 text-[#ff821c]" />
                                </div>
                                <p className="text-sm font-black uppercase tracking-wider text-white">Upload Pet Photo</p>
                                <p className="text-[9px] font-bold text-zinc-500 speed-safe mt-1 uppercase">Dogs, Cats, Hamsters, Birds etc.</p>
                              </div>
                            )}
                          </AnimatePresence>
                          <input 
                            type="file" 
                            hidden 
                            ref={fileInputRef} 
                            accept="image/*,.heic,.heif" 
                            onChange={handleFile} 
                          />
                        </div>
                      </div>

                      {/* Pet Name input (Required) */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block">Pet Name <span className="text-amber-500 font-bold">&#42;Required</span></label>
                        <div className="relative">
                          <input 
                            type="text" 
                            placeholder="E.g., Gabru, Oreo, Milo..."
                            value={petName}
                            onChange={(e) => {
                              setPetName(e.target.value);
                              if (showNameError) setShowNameError(false);
                            }}
                            className={`w-full bg-[#111622] border-2 px-4 py-3.5 rounded-2xl font-bold placeholder:text-zinc-600 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff821c]/30 text-white transition-all uppercase tracking-wide typehead-safe ${
                              showNameError ? 'border-red-500' : 'border-[#1e293b] focus:border-[#ff821c]'
                            }`}
                          />
                        </div>
                        {showNameError && (
                          <p className="text-red-500 text-[10px] font-black uppercase tracking-wider italic">Name is mandatory for official file verification!</p>
                        )}
                      </div>

                      {/* Language Selectors */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block flex items-center gap-1">
                          <Globe className="w-3 h-3 text-[#ff821c]" /> Generated Profile Language
                        </label>
                        <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                          {['English', 'हिन्दी', 'ಕನ್ನಡ', 'తెలుగు', 'മലയാളം', 'मराठी'].map((lang) => (
                            <button
                              key={lang}
                              onClick={() => setSelectedLanguage(lang)}
                              className={`py-2 px-1 rounded-xl border text-[11px] font-bold transition-all relative overflow-hidden ${
                                selectedLanguage === lang 
                                  ? 'bg-[#ff821c] text-black border-transparent font-black shadow-lg shadow-[#ff821c]/10' 
                                  : 'bg-[#111622] hover:bg-[#161c2b] text-zinc-400 border-[#1e293b]'
                              }`}
                            >
                              {lang}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Reveal Button */}
                      <button
                        onClick={analyzePet}
                        disabled={isAnalyzing}
                        className={`w-full py-4 rounded-2xl font-black uppercase tracking-wider text-sm transition-all shadow-lg flex items-center justify-center gap-2 group ${
                          isAnalyzing 
                            ? 'bg-zinc-800 text-zinc-400 border border-zinc-700 cursor-not-allowed' 
                            : 'bg-[#ff821c] text-black hover:scale-[1.02] active:scale-[0.98] shadow-[#ff821c]/20'
                        }`}
                      >
                        {isAnalyzing ? (
                          <div className="flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>{status || 'Decrypting alter-ego...'}</span>
                          </div>
                        ) : (
                          <>
                            <span>REVEAL SECRET LIFE 🐾</span>
                            <Zap className="w-4 h-4 fill-current group-hover:scale-125 transition-transform" />
                          </>
                        )}
                      </button>
                    </>
                  )}

                  {/* Past Generations */}
                  {pastGenerations.length > 0 && (
                    <div className="pt-4 border-t border-[#1e293b] space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block">My Past Investigations ({pastGenerations.length})</span>
                        <span className="text-[8px] font-black uppercase text-[#ff821c]/90 tracking-wider bg-[#ff821c]/10 border border-[#ff821c]/20 px-2 py-0.5 rounded-md">Saved for 7 days ⏰</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {pastGenerations.map((gen) => (
                          <div
                            key={gen.id}
                            onClick={() => loadSavedGen(gen)}
                            className="aspect-square rounded-xl bg-[#111622] border border-[#1e293b] hover:border-[#ff821c] p-1 cursor-pointer transition-all relative overflow-hidden group/thumb"
                          >
                            <img src={gen.genImage || gen.preview} className="w-full h-full object-cover rounded-lg group-hover/thumb:scale-105 transition-all" />
                            
                            {/* Delete Thumb */}
                            <button
                              onClick={(e) => deleteSavedGen(gen.id, e)}
                              className="absolute top-1 right-1 bg-black/80 hover:bg-red-600 rounded p-1 opacity-0 group-hover/thumb:opacity-100 transition-opacity z-10"
                            >
                              <Trash2 className="w-3 h-3 text-white" />
                            </button>
                            
                            {/* Pet Initial Overlay */}
                            <div className="absolute bottom-1 left-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold text-white uppercase tracking-tighter truncate max-w-[95%]">
                              {gen.name}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      
      {/* Universal Sharing Dialog Modal */}
      <AnimatePresence>
        {shareDialog.isOpen && result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#0f172a] border-2 border-amber-500/30 rounded-[28px] max-w-md w-full p-6 text-white shadow-2xl relative text-center"
            >
              {/* Close Button */}
              <button
                onClick={() => setShareDialog(prev => ({ ...prev, isOpen: false }))}
                className="absolute top-4 right-4 text-zinc-400 hover:text-white bg-slate-800/50 p-2 rounded-full transition-colors text-[10px] font-black uppercase tracking-widest"
              >
                ✕ Close
              </button>

              <div className="w-16 h-16 bg-amber-500/15 rounded-full flex items-center justify-center mx-auto mb-4 border border-amber-500/40">
                {shareDialog.platform === 'instagram' && <Instagram className="w-8 h-8 text-[#e1306c]" />}
                {shareDialog.platform === 'linkedin' && <Linkedin className="w-8 h-8 text-[#0077b5]" />}
                {shareDialog.platform === 'whatsapp' && <Share2 className="w-8 h-8 text-[#25d366]" />}
              </div>

              <h3 className="text-lg font-black uppercase tracking-wider mb-2">
                Share on {shareDialog.platform === 'instagram' ? 'Instagram' : shareDialog.platform === 'linkedin' ? 'LinkedIn' : 'WhatsApp'}
              </h3>

              {/* Status Message */}
              <div className="bg-[#1e293b]/50 border border-slate-700/60 rounded-xl p-3.5 text-xs text-zinc-300 font-semibold space-y-2.5 mb-5 text-left leading-relaxed">
                <div className="flex gap-2 items-start">
                  <span className="bg-green-500/20 text-green-400 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">✓</span>
                  <p>
                    <strong className="text-white font-black uppercase tracking-wide">Image Saved:</strong> Your pet's spy file has been automatically downloaded to your device!
                  </p>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="bg-green-500/20 text-green-400 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0">✓</span>
                  <p>
                    <strong className="text-white font-black uppercase tracking-wide">Bio Copied:</strong> The witty secret identity description has been copied to your clipboard!
                  </p>
                </div>
                <div className="border-t border-slate-800 my-2 pt-2 text-amber-500/90 font-black uppercase text-[10px] tracking-widest text-center">
                  ✨ READY TO POST!
                </div>
              </div>

              {/* Witty Caption Copy Box */}
              <div className="bg-[#090d16] border border-slate-800 rounded-xl p-3.5 mb-5 text-left text-xs text-zinc-400 italic relative min-h-[75px] flex flex-col justify-center">
                <span className="text-[8px] font-black text-amber-500/60 block uppercase tracking-wider mb-1 leading-none">Caption Clipboard Content</span>
                <span>"My pet {petName} is actually an undercover agent: "{result.identity}"! 🕵️‍♂️ Special Power: {result.talent}. Check your pet what its secret life is like: {window.location.origin} 🐾 #PetIntel"</span>
                
                {copiedCaptionState && (
                  <div className="absolute inset-0 bg-[#090d16]/95 flex items-center justify-center text-green-400 text-[10px] uppercase font-black tracking-widest rounded-xl transition-all">
                    <Check className="w-4 h-4 mr-1 stroke-[4]" /> Copied to Clipboard
                  </div>
                )}
              </div>

              {/* Quick Action Button for direct URL */}
              <div className="space-y-2.5">
                <a
                  href={
                    shareDialog.platform === 'instagram' 
                      ? 'https://www.instagram.com' 
                      : shareDialog.platform === 'linkedin' 
                      ? 'https://www.linkedin.com' 
                      : `https://api.whatsapp.com/send?text=${encodeURIComponent(`My pet ${petName} is actually an undercover agent: "${result.identity}"! 🕵️‍♂️ Special Power: ${result.talent}. Check your pet what its secret life is like: ${window.location.origin} 🐾 #PetIntel`)}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full bg-[#ff821c] text-black font-black uppercase py-3 rounded-xl hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 text-xs"
                >
                  Go to {shareDialog.platform === 'instagram' ? 'Instagram' : shareDialog.platform === 'linkedin' ? 'LinkedIn' : 'WhatsApp'} 🚀
                </a>

                <button
                  onClick={() => {
                    if (shareDialog.elementRef) {
                      downloadElementAsImage(shareDialog.elementRef, shareDialog.defaultFileName, shareDialog.bgColor);
                    }
                  }}
                  className="w-full border border-slate-700 font-semibold uppercase text-zinc-350 hover:text-white py-2 text-[10px] rounded-lg tracking-wider"
                >
                  Didn't download? Trigger Download again 📥
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="mt-auto border-t border-[#1e293b] bg-[#0c111a] py-6 px-4 flex flex-col md:flex-row items-center justify-between gap-4 text-center text-zinc-600 text-[9px] font-black uppercase tracking-[0.2em]">
        <div className="flex flex-col md:flex-row items-center gap-1 md:gap-3">
          <p className="text-[#ff821c]">pawstories.fun</p>
          <p className="hidden md:block">|</p>
          <p>© 2026 Undercover Domestic Agent Bureau</p>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => setIsTermsOpen(true)} className="hover:text-zinc-300 transition-colors">Terms of Service</button>
          <button onClick={() => setIsPrivacyOpen(true)} className="hover:text-zinc-300 transition-colors">Privacy Policy</button>
        </div>
      </footer>
      
      <PrivacyModal isOpen={isPrivacyOpen} onClose={() => setIsPrivacyOpen(false)} />
      <TermsModal isOpen={isTermsOpen} onClose={() => setIsTermsOpen(false)} />
    </div>
  );
}
