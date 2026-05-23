'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useIngestRecipe, usePendingIngestJobs, useCurrentUser, useDismissIngestJob } from '@/lib/hooks';
import { getIngestStatus, getIngestReview, confirmIngest, importRecipeFromUrl, ingestReceipt } from '@/lib/api';
import { ReceiptReview } from '@/components/ReceiptReview';
import type { IngestReviewPayload, IngestWarning, ReceiptItem } from '@/lib/types';
import { ScanLine, FolderOpen, FileText, Upload, Bot, Loader2, Clock, Users, AlertTriangle, Wand2, CheckCircle, X } from 'lucide-react';
import React from 'react';

const JPEG_QUALITY = 0.85;
const FINGERPRINT_SIZE = 16; // px — tiny canvas used for duplicate detection
const DUPLICATE_THRESHOLD = 0.92; // fraction of pixels that must match to flag as duplicate

/**
 * LIGHTWEIGHT IMAGE PIPELINE
 * Heavy Sobel-edge detection and canvas rotations are skipped to prevent
 * memory crashes on mobile devices. Users can rotate images on the recipe
 * detail page after import if needed.
 */
async function processImage(file: File): Promise<File> {
  return file;
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// Decodes a File to a tiny FINGERPRINT_SIZE×FINGERPRINT_SIZE canvas and
// returns the flattened RGBA pixel array for similarity comparison.

async function fingerprintImage(file: File): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = FINGERPRINT_SIZE;
  c.height = FINGERPRINT_SIZE;
  c.getContext('2d')!.drawImage(bitmap, 0, 0, FINGERPRINT_SIZE, FINGERPRINT_SIZE);
  bitmap.close();
  return c.getContext('2d')!.getImageData(0, 0, FINGERPRINT_SIZE, FINGERPRINT_SIZE).data;
}

function pixelSimilarity(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const TOLERANCE = 20; // per-channel delta allowed before counting as "different"
  let matches = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) <= TOLERANCE &&
      Math.abs(a[i + 1] - b[i + 1]) <= TOLERANCE &&
      Math.abs(a[i + 2] - b[i + 2]) <= TOLERANCE
    ) matches++;
  }
  return matches / pixels;
}

type FlowState = 'upload' | 'processing' | 'review' | 'done';
type ApiStatus = 'uploading' | 'queued' | 'processing' | 'review';

const STAGE_ICONS: Record<string, React.ReactNode> = {
  uploading: <Upload className="w-5 h-5" />,
  queued:    <Clock className="w-5 h-5" />,
  processing: <Bot className="w-5 h-5" />,
  review:    <Wand2 className="w-5 h-5" />,
};
const STAGES: { key: ApiStatus; label: string }[] = [
  { key: 'uploading', label: 'Uploading photo' },
  { key: 'queued',    label: 'In the queue' },
  { key: 'processing', label: 'Reading the card' },
  { key: 'review',    label: 'Almost ready!' },
];

const FUN_MESSAGES: Record<ApiStatus, string[]> = {
  uploading: [
    'Squishing your photo down to size...',
    'Sending the card over...',
  ],
  queued: [
    'Waiting for the AI chef to wake up...',
    'Your card is next in line!',
    'Warming up the neural networks...',
  ],
  processing: [
    'Teaching AI to read handwriting...',
    'Counting ingredients very carefully...',
    'Figuring out what a "knob of butter" is...',
    'Converting ounces to something sensible...',
    'Interrogating the recipe for hidden steps...',
    'Making sure it\'s actually food...',
    'Cross-referencing with 10,000 HelloFresh cards...',
    'Decoding chef\'s scrawl...',
  ],
  review: [
    'Checking everything looks tasty...',
    'Almost on your plate!',
  ],
};

export default function IngestPage() {
  const { data: pendingJobs } = usePendingIngestJobs();
  const dismissMutation = useDismissIngestJob();
  const [flowState, setFlowState] = useState<FlowState>('upload');
  const [capturedPhotos, setCapturedPhotos] = useState<{ file: File; url: string }[]>([]);
  const [photoRotations, setPhotoRotations] = useState<number[]>([0, 0]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [reviewPayload, setReviewPayload] = useState<IngestReviewPayload | null>(null);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState<{ id: string; title: string } | null>(null);
  const [uploadTab, setUploadTab] = useState<'scan' | 'url' | 'receipt'>('scan');
  const [urlInput, setUrlInput] = useState('');
  const [receiptFlowState, setReceiptFlowState] = useState<'upload' | 'extracting' | 'review'>('upload');
  const [receiptItems, setReceiptItems] = useState<ReceiptItem[] | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptInputMode, setReceiptInputMode] = useState<'photo' | 'pdf' | 'text'>('photo');
  const [receiptText, setReceiptText] = useState('');
  const receiptCameraRef = useRef<HTMLInputElement>(null);
  const receiptFileRef = useRef<HTMLInputElement>(null);
  const receiptPdfRef = useRef<HTMLInputElement>(null);
  const [urlLoading, setUrlLoading] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>('uploading');
  const [funMessageIdx, setFunMessageIdx] = useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showRawLlm, setShowRawLlm] = useState(false);
  const [kitBrand, setKitBrand] = useState<string>('auto');
  const { data: currentUser } = useCurrentUser();

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ingestMutation = useIngestRecipe();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Revoke preview URLs on unmount
  useEffect(() => {
    return () => {
      capturedPhotos.forEach((p) => URL.revokeObjectURL(p.url));
      if (pollRef.current) clearInterval(pollRef.current);
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cycle fun messages while processing
  useEffect(() => {
    if (flowState !== 'processing') {
      if (tickerRef.current) clearInterval(tickerRef.current);
      return;
    }
    tickerRef.current = setInterval(() => {
      setFunMessageIdx((i) => i + 1);
    }, 3500);
    return () => { if (tickerRef.current) clearInterval(tickerRef.current); };
  }, [flowState, apiStatus]);

  // Apply canvas rotation to a File (used at upload time)
  async function applyRotation(file: File, degrees: number): Promise<File> {
    if (degrees === 0) return file;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    const rad = (degrees * Math.PI) / 180;
    if (degrees === 90 || degrees === 270) {
      canvas.width = bitmap.height;
      canvas.height = bitmap.width;
    } else {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => resolve(new File([blob!], file.name, { type: 'image/jpeg' })),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  }

  // File picker: replaces all selected files (supports multi-select)
  async function handleFilesSelected(files: FileList | null) {
    try {
      if (!files || files.length === 0) return;
      const raw = Array.from(files).slice(0, 2);
      const resized = await Promise.all(raw.map(processImage));
      // Revoke old URLs and create new ones outside the state updater —
      // side effects inside state updaters can throw outside your try/catch
      // and trigger React's error boundary (the "Application error" screen).
      capturedPhotos.forEach((p) => URL.revokeObjectURL(p.url));
      const newPhotos = resized.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
      setCapturedPhotos(newPhotos);
      setPhotoRotations([0, 0]);
    } catch (err: any) {
      alert(`Photo capture error: ${err.message || 'Unknown error'}`);
    }
  }

  // Camera: accumulates up to 2 photos (each capture = one photo)
  async function handleCameraCapture(files: FileList | null) {
    try {
      if (!files || files.length === 0) return;
      // Extract the file BEFORE resetting the input — iOS Safari invalidates
      // the FileList when input.value is cleared, turning files[0] into undefined.
      const raw = files[0];
      if (cameraInputRef.current) cameraInputRef.current.value = '';
      let processed: File;
      try {
        processed = await processImage(raw);
      } catch {
        processed = raw;
      }
      // Create the URL and update state outside of a state-updater callback.
      // URL.createObjectURL / revokeObjectURL inside a setState updater run
      // during React's render cycle — if they throw, React's error boundary
      // catches it instead of your try/catch, causing the "Application error" screen.
      const newUrl = URL.createObjectURL(processed);
      const newItem = { file: processed, url: newUrl };
      if (capturedPhotos.length >= 2) {
        URL.revokeObjectURL(capturedPhotos[1].url);
        setCapturedPhotos([capturedPhotos[0], newItem]);
        setPhotoRotations((r) => [r[0], 0]);
      } else {
        setCapturedPhotos([...capturedPhotos, newItem]);
        setPhotoRotations((r) => [...r.slice(0, capturedPhotos.length), 0]);
      }
    } catch (err: any) {
      alert(`Camera error: ${err.message || 'Unknown error'}`);
    }
  }

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const status = await getIngestStatus(id);
        if (status.status === 'queued') {
          setApiStatus('queued');
        } else if (status.status === 'processing') {
          setApiStatus('processing');
        } else if (status.status === 'review' || status.status === 'complete') {
          setApiStatus('review');
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const payload = await getIngestReview(id);
          setReviewPayload(payload);
          setFlowState('review');
        } else if (status.status === 'failed') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setProcessingError(status.error_message ?? 'Processing failed');
          setFlowState('upload');
        }
      } catch (err: any) {
        clearInterval(pollRef.current!);
        pollRef.current = null;
        setProcessingError(err.message ?? 'Failed to check status');
        setFlowState('upload');
      }
    }, 2000);
  }, []);

  async function handleUpload() {
    if (capturedPhotos.length !== 2) return;

    // Apply any user-requested rotations before fingerprinting or uploading
    const rotatedFiles = await Promise.all(
      capturedPhotos.map((p, i) => applyRotation(p.file, photoRotations[i] ?? 0)),
    );

    // Duplicate check — compare pixel fingerprints before paying for a Bedrock call
    try {
      const [fpA, fpB] = await Promise.all(rotatedFiles.map((f) => fingerprintImage(f)));
      const similarity = pixelSimilarity(fpA, fpB);
      if (similarity >= DUPLICATE_THRESHOLD) {
        setProcessingError(
          'Both photos look like the same side of the card. Please take one photo of the front and one of the back.',
        );
        return;
      }
    } catch {
      // If fingerprinting fails for any reason, proceed anyway
    }

    const fd = new FormData();
    rotatedFiles.forEach((f) => fd.append('images', f));
    fd.append('kit_brand', kitBrand);

    try {
      setApiStatus('uploading');
      setFunMessageIdx(0);
      const result = await ingestMutation.mutateAsync(fd);
      setJobId(result.job_id);
      setProcessingError(null);
      setApiStatus('queued');
      setFlowState('processing');
      startPolling(result.job_id);
    } catch (err: any) {
      setProcessingError(err.message ?? 'Upload failed');
    }
  }

  async function handleConfirm(force = false) {
    if (!jobId || !reviewPayload) return;
    setConfirmLoading(true);
    try {
      const recipe = await confirmIngest(jobId, reviewPayload.parsed_recipe, force);
      setSavedRecipeId(recipe.id);
      setFlowState('done');
    } catch (err: any) {
      if (err.status === 409 && err.body?.detail?.code === 'DUPLICATE_RECIPE') {
        setDuplicateInfo({
          id: err.body.detail.duplicate_recipe_id,
          title: err.body.detail.duplicate_recipe_title,
        });
      } else {
        setProcessingError(err.message ?? 'Confirmation failed');
      }
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleUrlImport() {
    if (!urlInput.trim()) return;
    setUrlLoading(true);
    setProcessingError(null);
    try {
      const { job_id } = await importRecipeFromUrl(urlInput.trim());
      setJobId(job_id);
      const payload = await getIngestReview(job_id);
      setReviewPayload(payload);
      setFlowState('review');
    } catch (err: any) {
      setProcessingError(err.message ?? 'Failed to import recipe from URL');
    } finally {
      setUrlLoading(false);
    }
  }

  async function handleReceiptSubmit(source: File | FileList | string) {
    setReceiptError(null);
    setReceiptFlowState('extracting');
    const fd = new FormData();
    if (typeof source === 'string') {
      fd.append('text_content', source);
    } else if (source instanceof File) {
      fd.append('pdf', source);
    } else {
      Array.from(source).forEach((f) => fd.append('images', f));
    }
    try {
      const result = await ingestReceipt(fd);
      setReceiptItems(result.items);
      setReceiptFlowState('review');
    } catch (err: any) {
      setReceiptError(err?.message ?? 'Receipt processing failed. Please try again.');
      setReceiptFlowState('upload');
    }
  }

  function handleStartOver() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickerRef.current) clearInterval(tickerRef.current);
    setFlowState('upload');
    setCapturedPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setJobId(null);
    setReviewPayload(null);
    setSavedRecipeId(null);
    setProcessingError(null);
    setApiStatus('uploading');
    setFunMessageIdx(0);
  }

  // ---- Upload step ----
  if (flowState === 'upload') {
    return (
      <main className="max-w-lg mx-auto px-4 pt-6 pb-4 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-brand-ink dark:text-brand-background">{uploadTab === 'receipt' ? 'Add Receipt' : 'Add Recipe'}</h1>
        </div>

        {/* Pending review banner — resume or dismiss abandoned ingest jobs */}
        {pendingJobs && pendingJobs.length > 0 && (
          <div className="bg-brand-accent/10 dark:bg-brand-accent/20 border border-brand-accent/20 dark:border-brand-accent/30 rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <AlertTriangle className="w-4 h-4 text-brand-accent flex-shrink-0" />
              <p className="text-sm font-semibold text-brand-ink dark:text-brand-accent">
                {pendingJobs.length} recipe{pendingJobs.length > 1 ? 's' : ''} waiting to be confirmed
              </p>
            </div>
            <div className="divide-y divide-brand-accent/20 dark:divide-brand-accent/10">
              {pendingJobs.map((job, i) => (
                <div key={job.job_id} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1 text-xs text-brand-muted dark:text-brand-secondary truncate">
                    Scan {i + 1}
                  </span>
                  <button
                    onClick={async () => {
                      setJobId(job.job_id);
                      setProcessingError(null);
                      try {
                        const payload = await getIngestReview(job.job_id);
                        setReviewPayload(payload);
                        setFlowState('review');
                      } catch {
                        setProcessingError('Failed to load saved recipe — it may have expired.');
                      }
                    }}
                    className="text-xs font-bold text-brand-ink dark:text-brand-background bg-brand-accent/20 dark:bg-brand-accent/30 px-2.5 py-1 rounded-lg hover:bg-brand-accent/40 transition-colors whitespace-nowrap"
                  >
                    Resume →
                  </button>
                  <button
                    onClick={() => dismissMutation.mutate(job.job_id)}
                    disabled={dismissMutation.isPending}
                    className="w-6 h-6 flex items-center justify-center rounded-md text-brand-muted hover:text-brand-tomato hover:bg-brand-tomato/10 transition-colors disabled:opacity-40"
                    aria-label="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab switcher */}
        <div className="flex gap-1 bg-brand-linen/20 dark:bg-brand-primary-hover/50 p-1 rounded-xl">
          <button
            onClick={() => setUploadTab('scan')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
              uploadTab === 'scan'
                ? 'bg-brand-card dark:bg-brand-primary text-brand-ink dark:text-brand-background shadow-sm'
                : 'text-brand-muted dark:text-brand-secondary hover:text-brand-ink dark:hover:text-brand-background'
            }`}
          >
            Scanner
          </button>
          <button
            onClick={() => setUploadTab('url')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
              uploadTab === 'url'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            Import URL
          </button>
          <button
            onClick={() => setUploadTab('receipt')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
              uploadTab === 'receipt'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            Receipt
          </button>
        </div>

        {processingError && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
            {processingError}
          </div>
        )}

        {/* URL import panel */}
        {uploadTab === 'url' && (
          <div className="space-y-3">
            <p className="text-sm text-brand-muted dark:text-brand-secondary">
              Paste a recipe URL from BBC Good Food, AllRecipes, or any recipe site.
            </p>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleUrlImport()}
              placeholder="https://www.bbcgoodfood.com/recipes/..."
              className="w-full px-4 py-3 rounded-xl bg-brand-card dark:bg-brand-primary-hover border border-brand-linen dark:border-brand-primary/60 text-sm text-brand-ink dark:text-brand-background placeholder-brand-muted focus:outline-none focus:ring-2 focus:ring-brand-accent focus:border-transparent transition"
            />
            <button
              onClick={handleUrlImport}
              disabled={!urlInput.trim() || urlLoading}
              className="w-full py-4 bg-brand-primary text-brand-background font-semibold rounded-2xl hover:bg-brand-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {urlLoading ? 'Fetching recipe…' : 'Fetch Recipe'}
            </button>
            <p className="text-xs text-brand-muted dark:text-brand-secondary text-center">
              Works best with structured recipe pages. JavaScript-heavy sites may not work.
            </p>
          </div>
        )}

        {/* Receipt tab */}
        {uploadTab === 'receipt' && (
          <div className="space-y-4">
            {receiptFlowState === 'review' && receiptItems ? (
              <ReceiptReview
                items={receiptItems}
                onDone={() => {
                  setReceiptFlowState('upload');
                  setReceiptItems(null);
                  setReceiptText('');
                }}
              />
            ) : (
              <>
                {/* Sub-tab: photo / pdf / text */}
                <div className="flex gap-1 bg-gray-50 dark:bg-gray-900 p-1 rounded-lg border border-gray-200 dark:border-gray-700">
                  {(['photo', 'pdf', 'text'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setReceiptInputMode(mode)}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                        receiptInputMode === mode
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'
                      }`}
                    >
                      {mode === 'photo' ? 'Photo' : mode === 'pdf' ? 'PDF' : 'Paste Text'}
                    </button>
                  ))}
                </div>

                {receiptError && (
                  <div className="p-3 bg-brand-tomato/10 dark:bg-brand-tomato/20 border border-brand-tomato/20 dark:border-brand-tomato/30 rounded-xl text-sm text-brand-tomato">
                    {receiptError}
                  </div>
                )}

                {receiptInputMode === 'photo' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Take a photo of your supermarket receipt or upload an image.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => receiptCameraRef.current?.click()}
                        className="flex flex-col items-center gap-2 p-5 border-2 border-dashed border-brand-linen dark:border-brand-primary-hover rounded-2xl text-brand-muted dark:text-brand-secondary hover:border-brand-accent/50 dark:hover:border-brand-accent hover:text-brand-primary dark:hover:text-brand-background transition-colors bg-brand-card dark:bg-brand-primary"
                      >
                        <ScanLine className="w-8 h-8" />
                        <span className="text-sm font-medium">Camera</span>
                      </button>
                      <button
                        onClick={() => receiptFileRef.current?.click()}
                        className="flex flex-col items-center gap-2 p-5 border-2 border-dashed border-brand-linen dark:border-brand-primary-hover rounded-2xl text-brand-muted dark:text-brand-secondary hover:border-brand-accent/50 dark:hover:border-brand-accent hover:text-brand-primary dark:hover:text-brand-background transition-colors bg-brand-card dark:bg-brand-primary"
                      >
                        <FolderOpen className="w-8 h-8" />
                        <span className="text-sm font-medium">Choose File</span>
                      </button>
                    </div>
                    <input
                      ref={receiptCameraRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => { if (e.target.files?.length) handleReceiptSubmit(e.target.files); }}
                    />
                    <input
                      ref={receiptFileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => { if (e.target.files?.length) handleReceiptSubmit(e.target.files); }}
                    />
                    {receiptFlowState === 'extracting' && (
                      <div className="text-center py-6 space-y-2">
                        <div className="w-8 h-8 border-2 border-brand-linen dark:border-brand-primary-hover border-t-brand-primary rounded-full animate-spin mx-auto" />
                        <p className="text-sm text-brand-muted dark:text-brand-secondary">Reading your receipt…</p>
                      </div>
                    )}
                  </div>
                )}

                {receiptInputMode === 'pdf' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Upload an Ocado, Amazon Fresh, or other grocery order PDF.
                    </p>
                    <button
                      onClick={() => receiptPdfRef.current?.click()}
                      disabled={receiptFlowState === 'extracting'}
                      className="w-full flex flex-col items-center gap-2 p-6 border-2 border-dashed border-brand-linen dark:border-brand-primary-hover rounded-2xl text-brand-muted dark:text-brand-secondary hover:border-brand-accent/50 dark:hover:border-brand-accent hover:text-brand-primary dark:hover:text-brand-background transition-colors bg-brand-card dark:bg-brand-primary disabled:opacity-50"
                    >
                      <FileText className="w-8 h-8" />
                      <span className="text-sm font-medium">
                        {receiptFlowState === 'extracting' ? 'Processing…' : 'Choose PDF'}
                      </span>
                    </button>
                    <input
                      ref={receiptPdfRef}
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => { if (e.target.files?.[0]) handleReceiptSubmit(e.target.files[0]); }}
                    />
                    {receiptFlowState === 'extracting' && (
                      <div className="text-center py-4 space-y-2">
                        <div className="w-8 h-8 border-2 border-brand-linen dark:border-brand-primary-hover border-t-brand-primary rounded-full animate-spin mx-auto" />
                        <p className="text-sm text-brand-muted dark:text-brand-secondary">Extracting items from PDF…</p>
                      </div>
                    )}
                  </div>
                )}

                {receiptInputMode === 'text' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Paste the text from an online order confirmation email.
                    </p>
                    <textarea
                      value={receiptText}
                      onChange={(e) => setReceiptText(e.target.value)}
                      placeholder="Paste your order items here…"
                      rows={8}
                      className="w-full px-3 py-2.5 rounded-xl bg-brand-card dark:bg-brand-primary-hover border border-brand-linen dark:border-brand-primary/60 text-sm text-brand-ink dark:text-brand-background placeholder-brand-muted focus:outline-none focus:ring-2 focus:ring-brand-accent resize-none"
                    />
                    <button
                      onClick={() => receiptText.trim() && handleReceiptSubmit(receiptText.trim())}
                      disabled={!receiptText.trim() || receiptFlowState === 'extracting'}
                      className="w-full py-3 bg-brand-primary text-brand-background font-semibold rounded-2xl hover:bg-brand-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {receiptFlowState === 'extracting' ? 'Processing…' : 'Extract Items'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Upload buttons */}
        {uploadTab === 'scan' && <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => cameraInputRef.current?.click()}
            className="flex flex-col items-center gap-2 p-5 border-2 border-dashed border-brand-linen dark:border-brand-primary-hover rounded-2xl text-brand-muted dark:text-brand-secondary hover:border-brand-accent/50 dark:hover:border-brand-accent hover:text-brand-primary dark:hover:text-brand-background transition-colors bg-brand-card dark:bg-brand-primary"
          >
            <ScanLine className="w-8 h-8" />
            <span className="text-sm font-medium">
              {capturedPhotos.length === 0 ? 'Take Photo' : capturedPhotos.length === 1 ? 'Add 2nd Photo' : 'Retake Photo'}
            </span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center gap-2 p-5 border-2 border-dashed border-brand-linen dark:border-brand-primary-hover rounded-2xl text-brand-muted dark:text-brand-secondary hover:border-brand-accent/50 dark:hover:border-brand-accent hover:text-brand-primary dark:hover:text-brand-background transition-colors bg-brand-card dark:bg-brand-primary"
          >
            <FolderOpen className="w-8 h-8" />
            <span className="text-sm font-medium">Choose File</span>
          </button>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => handleCameraCapture(e.target.files)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
        </div>}

        {uploadTab === 'scan' && <>
          {/* Previews */}
          {capturedPhotos.length > 0 && (
            <div className="flex gap-3">
              {capturedPhotos.map((p, i) => (
                <div key={i} className="relative flex-1 aspect-video rounded-xl overflow-hidden bg-brand-linen/20 dark:bg-brand-primary-hover/50 border border-brand-linen dark:border-brand-primary/60">
                  <img
                    src={p.url}
                    alt={`Preview ${i + 1}`}
                    className="w-full h-full object-contain transition-transform duration-300"
                    style={{ transform: `rotate(${photoRotations[i] ?? 0}deg)` }}
                  />
                  <button
                    onClick={() => {
                      URL.revokeObjectURL(p.url);
                      setCapturedPhotos((prev) => prev.filter((_, idx) => idx !== i));
                      setPhotoRotations((r) => r.map((v, ri) => (ri === i ? 0 : v)));
                    }}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white text-xs flex items-center justify-center hover:bg-black/70"
                    aria-label="Remove photo"
                  >
                    ×
                  </button>
                  <button
                    onClick={() => setPhotoRotations((r) => r.map((v, ri) => (ri === i ? (v + 90) % 360 : v)))}
                    className="absolute bottom-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                    aria-label="Rotate photo"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <span className="absolute bottom-1 left-1 text-xs bg-black/40 text-white px-1.5 py-0.5 rounded">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          )}

          {capturedPhotos.length === 1 && (
            <p className="text-sm text-center text-brand-accent font-medium">
              Add the other side of the card to continue
            </p>
          )}

          {/* Brand selector */}
          <div>
            <p className="text-xs font-medium text-brand-muted dark:text-brand-secondary mb-2">Meal kit brand</p>
            <div className="flex flex-wrap gap-2">
              {[
                { value: 'auto', label: 'Auto-detect' },
                { value: 'hellofresh', label: 'HelloFresh' },
                { value: 'gousto', label: 'Gousto' },
                { value: 'dinnerly', label: 'Dinnerly' },
                { value: 'everyplate', label: 'EveryPlate' },
                { value: 'mindfulchef', label: 'Mindful Chef' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKitBrand(value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    kitBrand === value
                      ? 'bg-brand-primary text-brand-background'
                      : 'bg-brand-linen/20 dark:bg-brand-primary-hover text-brand-muted dark:text-brand-secondary hover:bg-brand-linen/40 dark:hover:bg-brand-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleUpload}
            disabled={capturedPhotos.length !== 2 || ingestMutation.isPending}
            className="w-full py-4 bg-brand-primary text-brand-background font-semibold rounded-2xl hover:bg-brand-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {ingestMutation.isPending ? 'Uploading...' : capturedPhotos.length === 2 ? 'Upload & Process' : `${capturedPhotos.length}/2 photos — add ${2 - capturedPhotos.length} more`}
          </button>
        </>}
      </main>
    );
  }

  // ---- Processing step ----
  if (flowState === 'processing') {
    const currentStageIdx = STAGES.findIndex((s) => s.key === apiStatus);
    const messages = FUN_MESSAGES[apiStatus];
    const funMessage = messages[funMessageIdx % messages.length];

    return (
      <main className="max-w-lg mx-auto px-4 pt-10 pb-4 flex flex-col gap-8">
        {/* Stage steps */}
        <div className="space-y-3">
          {STAGES.map((stage, idx) => {
            const done = idx < currentStageIdx;
            const active = idx === currentStageIdx;
            return (
              <div
                key={stage.key}
                className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${
                  active
                    ? 'bg-brand-herb/10 dark:bg-brand-herb/20 border-brand-herb/20 dark:border-brand-herb/30 shadow-sm'
                    : done
                    ? 'bg-brand-card dark:bg-brand-primary border-brand-linen/20 dark:border-brand-primary-hover/30 opacity-50'
                    : 'bg-brand-card dark:bg-brand-primary border-brand-linen/20 dark:border-brand-primary-hover/30 opacity-30'
                }`}
              >
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg flex-shrink-0 ${
                  active ? 'bg-brand-herb/20 dark:bg-brand-herb/30' : done ? 'bg-brand-linen/20 dark:bg-brand-primary-hover/20' : 'bg-brand-linen/10 dark:bg-brand-primary-hover/10'
                }`}>
                  {done ? <CheckCircle className="w-5 h-5 text-brand-herb" /> : active ? (
                    <Loader2 className="w-5 h-5 animate-spin text-brand-herb" />
                  ) : STAGE_ICONS[stage.key]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold ${active ? 'text-brand-herb' : 'text-brand-muted dark:text-brand-secondary'}`}>
                    {stage.label}
                  </p>
                  {active && (
                    <p className="text-xs text-brand-herb/80 dark:text-brand-herb mt-0.5 truncate">{funMessage}</p>
                  )}
                </div>
                {active && (
                  <div className="w-4 h-4 rounded-full border-2 border-indigo-300 border-t-indigo-600 animate-spin flex-shrink-0" />
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={handleStartOver}
          className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-center"
        >
          Cancel
        </button>
      </main>
    );
  }

  // ---- Review step ----
  if (flowState === 'review' && reviewPayload) {
    const pr = reviewPayload.parsed_recipe;

    // Stage-2 self-review warnings. Split into per-ingredient and recipe-level
    // so we can decorate ingredient rows individually and surface global
    // issues (nutrition, cooking_time, etc.) in a banner above the list.
    const allWarnings: IngestWarning[] = reviewPayload.warnings ?? [];
    const ingredientWarningByName = new Map<string, IngestWarning>();
    const recipeLevelWarnings: IngestWarning[] = [];
    for (const w of allWarnings) {
      if (w.ingredient) {
        ingredientWarningByName.set(w.ingredient.toLowerCase(), w);
      } else {
        recipeLevelWarnings.push(w);
      }
    }

    return (
      <main className="max-w-lg mx-auto px-4 pt-6 pb-4 space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Review Recipe</h1>
          <button onClick={handleStartOver} className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
            Start Over
          </button>
        </div>

        {processingError && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
            {processingError}
          </div>
        )}

        {/* Parsed recipe summary */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-4 shadow-sm space-y-2">
          <h2 className="font-semibold text-gray-800 dark:text-gray-100 text-base">{pr?.title ?? 'Unknown title'}</h2>
          <div className="flex gap-4 text-sm text-gray-500 dark:text-gray-400">
            {pr?.cooking_time_mins && <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {pr.cooking_time_mins} min</span>}
            {pr?.base_servings && <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> Serves {pr.base_servings}</span>}
          </div>
          {pr?.mood_tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pr.mood_tags.map((tag: string) => (
                <span key={tag} className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Recipe-level warnings from Stage-2 self-review (nutrition, cooking_time, etc.) */}
        {recipeLevelWarnings.length > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> Possible extraction issues ({recipeLevelWarnings.length})
            </h3>
            <ul className="space-y-1.5">
              {recipeLevelWarnings.map((w, i) => (
                <li key={i} className="text-xs text-red-700 dark:text-red-400">
                  <span className="font-medium">{w.field}:</span> {w.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Ingredients */}
        {pr?.ingredients?.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Ingredients</h3>
            <ul className="space-y-1.5">
              {pr.ingredients.map((ing: any, i: number) => {
                const name = ing.raw_name ?? ing.name ?? '';
                const isUnresolved = reviewPayload.unresolved_ingredients.includes(name);
                const warning = ingredientWarningByName.get(name.toLowerCase());
                const hasWarning = !!warning;
                return (
                  <li key={i} className="text-sm">
                    <div className="flex items-center gap-2">
                      {hasWarning
                        ? <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                        : isUnresolved
                          ? <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                          : <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
                      <span className={
                        hasWarning ? 'text-red-700 dark:text-red-400'
                        : isUnresolved ? 'text-yellow-700 dark:text-yellow-400'
                        : 'text-gray-800 dark:text-gray-200'
                      }>
                        {name}
                      </span>
                      {ing.quantity && (
                        <span className={`text-xs ml-auto ${hasWarning ? 'text-red-500 dark:text-red-400 font-medium' : 'text-gray-400 dark:text-gray-500'}`}>
                          {ing.quantity} {ing.unit ?? ''}
                        </span>
                      )}
                    </div>
                    {hasWarning && (
                      <p className="text-xs text-red-600 dark:text-red-400 ml-6 mt-0.5">
                        {warning.reason}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {(reviewPayload.unresolved_ingredients.length > 0 || ingredientWarningByName.size > 0) && (
              <div className="mt-2 space-y-1">
                {reviewPayload.unresolved_ingredients.length > 0 && (
                  <p className="text-xs text-yellow-600 dark:text-yellow-400">
                    <span className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {reviewPayload.unresolved_ingredients.length} ingredient(s) could not be automatically resolved</span>
                  </p>
                )}
                {ingredientWarningByName.size > 0 && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    <span className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {ingredientWarningByName.size} ingredient(s) flagged for likely extraction error — please verify before saving</span>
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Steps */}
        {pr?.steps?.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Steps ({pr.steps.length})</h3>
            <ol className="space-y-2">
              {pr.steps.map((step: any, i: number) => (
                <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-xs flex items-center justify-center font-medium">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{step.text ?? step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Admin: raw LLM response viewer */}
        {currentUser?.is_admin && reviewPayload.raw_llm_response && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
            <button
              onClick={() => setShowRawLlm((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <span>Raw LLM Response</span>
              <span className="text-xs font-normal text-gray-400">{showRawLlm ? 'Hide ▲' : 'Show ▼'}</span>
            </button>
            {showRawLlm && (
              <pre className="px-4 pb-4 text-xs text-gray-600 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto border-t border-gray-100 dark:border-gray-700">
                {reviewPayload.raw_llm_response}
              </pre>
            )}
          </div>
        )}

        <button
          onClick={() => handleConfirm(false)}
          disabled={confirmLoading}
          className="w-full py-4 bg-indigo-600 text-white font-semibold rounded-2xl hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {confirmLoading ? 'Saving...' : 'Confirm Recipe'}
        </button>

        {/* Duplicate detection modal */}
        {duplicateInfo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">Possible duplicate</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    This recipe card looks similar to <span className="font-medium text-gray-700 dark:text-gray-200">{duplicateInfo.title}</span> already in your library.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Link
                  href={`/recipes/${duplicateInfo.id}`}
                  className="w-full py-2.5 text-center bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 transition-colors text-sm"
                >
                  View existing recipe
                </Link>
                <button
                  onClick={() => { setDuplicateInfo(null); handleConfirm(true); }}
                  disabled={confirmLoading}
                  className="w-full py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium rounded-xl hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-sm disabled:opacity-50"
                >
                  Save anyway
                </button>
                <button
                  onClick={() => setDuplicateInfo(null)}
                  className="w-full py-2.5 text-gray-400 dark:text-gray-500 text-sm hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  // ---- Done step ----
  if (flowState === 'done') {
    return (
      <main className="max-w-lg mx-auto px-4 pt-16 pb-4 flex flex-col items-center gap-5 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Recipe Saved!</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Your recipe card has been added to the library</p>
        </div>
        <div className="flex gap-3 w-full">
          {savedRecipeId && (
            <Link
              href={`/recipes/${savedRecipeId}`}
              className="flex-1 py-3.5 bg-indigo-600 text-white text-center font-semibold rounded-2xl hover:bg-indigo-700 transition-colors"
            >
              View Recipe
            </Link>
          )}
          <button
            onClick={handleStartOver}
            className="flex-1 py-3.5 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 font-medium rounded-2xl hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Scan Another
          </button>
        </div>
      </main>
    );
  }

  return null;
}
