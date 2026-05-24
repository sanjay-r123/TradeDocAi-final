'use client';

import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Schema } from '../types';
import { authHeaders, API_BASE } from '../../../lib/api';

const CustomPDFViewer = dynamic(() => import('./CustomPDFViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="w-10 h-10 border-4 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">
        Loading PDF Preview...
      </p>
    </div>
  ),
});

interface PlacedField {
  id: string;
  type: 'signature' | 'name' | 'title' | 'date' | 'text';
  label: string;
  x: number;
  y: number;
  value: string;
}

interface DispatchCenterUIProps {
  docId: string;
  activeSchema: Schema;
  pdfUrl: string;
  pdfFilename: string;
  onClose: () => void;
  onShowToast: (msg: string) => void;
  onFetchRecentDocs: () => void;
}

export default function DispatchCenterUI({
  docId,
  activeSchema,
  pdfUrl,
  pdfFilename,
  onClose,
  onShowToast,
  onFetchRecentDocs,
}: DispatchCenterUIProps) {
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  
  // Custom Local Signature states
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [bankerName, setBankerName] = useState('Sanjay R');
  const [bankerTitle, setBankerTitle] = useState('Managing Director');
  const [stampedDate, setStampedDate] = useState(new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }));
  
  // Acrobat / DocuSeal Dynamic Fields State
  const [placedFields, setPlacedFields] = useState<PlacedField[]>([
    { id: 'sig', type: 'signature', label: 'Signature', x: 25, y: 78, value: '' },
    { id: 'name', type: 'name', label: 'Signatory Name', x: 45, y: 76, value: 'Sanjay R' },
    { id: 'title', type: 'title', label: 'Corporate Title', x: 45, y: 81, value: 'Managing Director' },
    { id: 'date', type: 'date', label: 'Signing Date', x: 45, y: 86, value: new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) }
  ]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // DocuSeal states
  const [builderToken, setBuilderToken] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const [counterpartySignUrl, setCounterpartySignUrl] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<'recipient' | 'self_sign' | 'place_fields' | 'complete'>('recipient');
  const [copied, setCopied] = useState(false);

  const isFx = activeSchema.id === 'fx_ndf';

  // Initialize Canvas stroke styles
  useEffect(() => {
    if (activeStep !== 'self_sign') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Scale for high DPI displays
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    
    ctx.strokeStyle = '#1e1b4b'; // dark navy signature ink
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [activeStep]);

  // Load DocuSeal builder script dynamically
  useEffect(() => {
    if (isFx) return;
    
    const scriptId = 'docuseal-builder-script';
    let script = document.getElementById(scriptId) as HTMLScriptElement;
    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://cdn.docuseal.com/js/builder.js';
      script.async = true;
      script.onload = () => setScriptLoaded(true);
      document.body.appendChild(script);
    } else {
      setScriptLoaded(true);
    }
  }, [isFx]);

  // Fetch Token only when entering step 3 (Client Field Placement)
  const fetchBuilderToken = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/documents/${docId}/builder-token`, {
        headers: authHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        setBuilderToken(data.token);
        setActiveStep('place_fields');
      } else {
        onShowToast('⚠️ Failed to load template editor workspace');
      }
    } catch {
      onShowToast('❌ Network error loading template editor workspace');
    }
    setLoading(false);
  };

  // Canvas Drawing Handlers
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  // Touch Support for mobile/tablets
  const startDrawingTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || e.touches.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
    setIsDrawing(true);
  };

  const drawTouch = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || e.touches.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
    ctx.stroke();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setSignatureImage(null);
    setPlacedFields(prev => prev.map(f => f.type === 'signature' ? { ...f, value: '' } : f));
  };

  const acceptSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    setSignatureImage(dataUrl);
    setPlacedFields(prev => prev.map(f => f.type === 'signature' ? { ...f, value: dataUrl } : f));
    onShowToast('📋 Signature captured! Position your signature stamp on the document.');
  };

  // Dynamic Fields Helpers
  const addField = (type: 'signature' | 'name' | 'title' | 'date' | 'text') => {
    const id = `${type}_${Date.now()}`;
    let label = '';
    let defaultValue = '';
    
    switch (type) {
      case 'signature':
        label = 'Signature';
        defaultValue = signatureImage || '';
        break;
      case 'name':
        label = 'Signatory Name';
        defaultValue = bankerName;
        break;
      case 'title':
        label = 'Corporate Title';
        defaultValue = bankerTitle;
        break;
      case 'date':
        label = 'Signing Date';
        defaultValue = stampedDate;
        break;
      case 'text':
        label = 'Custom Text';
        defaultValue = 'Enter text here';
        break;
    }
    
    // Spawn at a neat staggered coordinate
    const newField: PlacedField = {
      id,
      type,
      label,
      x: 35 + (placedFields.length * 4) % 25,
      y: 40 + (placedFields.length * 5) % 25,
      value: defaultValue
    };
    
    setPlacedFields(prev => [...prev, newField]);
    setSelectedFieldId(id);
    onShowToast(`➕ Added ${label} field. Drag to place!`);
  };

  const updateSelectedFieldValue = (val: string) => {
    if (!selectedFieldId) return;
    setPlacedFields(prev => prev.map(f => f.id === selectedFieldId ? { ...f, value: val } : f));
    // Keep local states in sync if editing core banker fields
    const field = placedFields.find(f => f.id === selectedFieldId);
    if (field) {
      if (field.type === 'name') setBankerName(val);
      if (field.type === 'title') setBankerTitle(val);
    }
  };

  // Draggable Event Handlers
  const onDragMove = (e: React.MouseEvent) => {
    if (!activeDragId) return;
    const container = e.currentTarget.getBoundingClientRect();
    
    const deltaX = ((e.clientX - dragStart.x) / container.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / container.height) * 100;
    
    setPlacedFields(prev => prev.map(field => {
      if (field.id === activeDragId) {
        const widthOffset = field.type === 'signature' ? 16 : 22;
        const heightOffset = field.type === 'signature' ? 8 : 6;
        return {
          ...field,
          x: Math.max(0, Math.min(100 - widthOffset, field.x + deltaX)),
          y: Math.max(0, Math.min(100 - heightOffset, field.y + deltaY))
        };
      }
      return field;
    }));
    
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const startDrag = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setActiveDragId(id);
    setSelectedFieldId(id);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const endDrag = () => {
    setActiveDragId(null);
  };

  // Stamping and Saving locally using PyMuPDF
  const handleLocalStamping = async () => {
    const sigField = placedFields.find(f => f.type === 'signature');
    if (!sigField || !sigField.value) {
      onShowToast('⚠️ Please draw and capture your signature first');
      return;
    }

    setLoading(true);
    try {
      const textFieldsPayload = placedFields
        .filter(f => f.type !== 'signature' && f.value.trim() !== '')
        .map(f => ({
          text: f.value,
          x_pct: f.x / 100,
          y_pct: f.y / 100
        }));

      const payload = {
        page_num: 0,
        sig_x_pct: sigField.x / 100,
        sig_y_pct: sigField.y / 100,
        sig_w_pct: 0.16, // Fixed relative stamp width
        sig_h_pct: 0.08, // Fixed relative stamp height
        signature_base64: sigField.value,
        text_fields: textFieldsPayload
      };

      const response = await fetch(`${API_BASE}/api/documents/${docId}/sign-local`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let err = 'Failed to apply signature';
        try {
          const d = await response.json();
          err = d.error || err;
        } catch {}
        onShowToast('❌ ' + err);
        setLoading(false);
        return;
      }

      onShowToast('✍️ Signature applied and stitched to PDF successfully!');
      fetchBuilderToken(); // Advance directly to client field layout
    } catch {
      onShowToast('❌ Server error during signature application');
      setLoading(false);
    }
  };

  const handleDispatch = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/documents/${docId}/dispatch`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          signer_email: signerEmail.trim(),
          signer_name: signerName.trim(),
          message: customMessage.trim(),
        }),
      });

      if (!response.ok) {
        let errMsg = 'Failed to dispatch document';
        try {
          const d = await response.json();
          errMsg = d.error || errMsg;
        } catch {}
        onShowToast('❌ ' + errMsg);
        setLoading(false);
        return;
      }

      const result = await response.json();
      setDispatched(true);
      onFetchRecentDocs();

      if (isFx) {
        onShowToast('✉️ Trade Confirmation emailed successfully!');
        setActiveStep('complete');
      } else {
        setCounterpartySignUrl(result.counterparty_sign_url);
        onShowToast('✉️ Signature request emailed to client!');
        setActiveStep('complete');
      }
    } catch {
      onShowToast('❌ Network error during dispatch');
    }
    setLoading(false);
  };

  const handleCopyLink = () => {
    if (counterpartySignUrl) {
      navigator.clipboard.writeText(counterpartySignUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onShowToast('📋 Link copied to clipboard!');
    }
  };

  const selectedField = placedFields.find(f => f.id === selectedFieldId);

  return (
    <div className="flex flex-col min-h-full animate-fade-in gap-6 pb-8">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{activeSchema.icon || '🚀'}</span>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 font-inter tracking-tight">
              Dispatch Center — {activeSchema.name}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 font-medium">
            Review your compiled Trade Confirmation PDF and launch the distribution/signature workflow.
          </p>
        </div>
        <button
          onClick={onClose}
          className="px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-slate-600 rounded-xl text-xs font-bold transition-all border border-slate-200/50 flex items-center justify-center gap-1.5 w-fit"
        >
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Documents
        </button>
      </div>

      {/* Process tracker */}
      <div className="flex items-center justify-between bg-slate-50 border border-slate-100 p-4 rounded-3xl mb-2 shadow-sm select-none">
        <div className="flex items-center justify-around w-full max-w-4xl mx-auto px-4 gap-4">
          
          {/* Step 1 */}
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
              activeStep === 'recipient' 
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                : ['self_sign', 'place_fields', 'complete'].includes(activeStep)
                  ? 'bg-emerald-500 text-white'
                  : 'bg-slate-200 text-slate-500'
            }`}>
              {['self_sign', 'place_fields', 'complete'].includes(activeStep) ? '✓' : '1'}
            </div>
            <span className={`text-xs font-bold transition-colors hidden sm:inline ${
              activeStep === 'recipient' ? 'text-indigo-600 font-black' : 'text-slate-500'
            }`}>
              Recipient Configuration
            </span>
          </div>

          {!isFx && (
            <>
              <div className="flex-1 h-0.5 max-w-[60px] bg-slate-200 rounded-full" />
              
              {/* Step 2 */}
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                  activeStep === 'self_sign' 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                    : ['place_fields', 'complete'].includes(activeStep)
                      ? 'bg-emerald-500 text-white'
                      : 'bg-slate-200 text-slate-500'
                }`}>
                  {['place_fields', 'complete'].includes(activeStep) ? '✓' : '2'}
                </div>
                <span className={`text-xs font-bold transition-colors hidden sm:inline ${
                  activeStep === 'self_sign' ? 'text-indigo-600 font-black' : 'text-slate-500'
                }`}>
                  Banker Local Sign
                </span>
              </div>

              <div className="flex-1 h-0.5 max-w-[60px] bg-slate-200 rounded-full" />
              
              {/* Step 3 */}
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                  activeStep === 'place_fields' 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                    : activeStep === 'complete'
                      ? 'bg-emerald-500 text-white'
                      : 'bg-slate-200 text-slate-500'
                }`}>
                  {activeStep === 'complete' ? '✓' : '3'}
                </div>
                <span className={`text-xs font-bold transition-colors hidden sm:inline ${
                  activeStep === 'place_fields' ? 'text-indigo-600 font-black' : 'text-slate-500'
                }`}>
                  Client Field Placement
                </span>
              </div>
            </>
          )}

          <div className="flex-1 h-0.5 max-w-[60px] bg-slate-200 rounded-full" />

          {/* Step 4 */}
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
              activeStep === 'complete' 
                ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 ring-4 ring-emerald-50' 
                : 'bg-slate-200 text-slate-500'
            }`}>
              {isFx ? '2' : '4'}
            </div>
            <span className={`text-xs font-bold transition-colors hidden sm:inline ${
              activeStep === 'complete' ? 'text-emerald-500 font-black' : 'text-slate-500'
            }`}>
              Dispatch Executed
            </span>
          </div>

        </div>
      </div>

      {/* Main Process Wizard Sections */}
      <div className="flex-1 flex flex-col gap-6 min-h-0 items-stretch">
        
        {/* ==================== STEP 1: RECIPIENT CONFIGURATION ==================== */}
        {activeStep === 'recipient' && (
          <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch animate-fade-in">
            {/* Left Panel: Compiled PDF Preview */}
            <div className="flex-1 min-h-[400px] xl:max-h-[calc(100vh-280px)] bg-slate-50 border border-slate-100 rounded-3xl overflow-hidden relative shadow-inner">
              <CustomPDFViewer
                pdfUrl={pdfUrl}
                filename={pdfFilename || 'Confirmation'}
                onClose={onClose}
                onDownload={() => {}}
                onPrint={() => {}}
                isAiCreated={false}
                hasExistingReport={false}
                hideSidebar={true}
                hideToolbar={true}
              />
            </div>

            {/* Right Panel: Spacious Recipient Config */}
            <div className="w-full xl:w-[460px] bg-white border border-slate-100 rounded-3xl shadow-xl flex flex-col p-6 sm:p-8 min-w-0 shrink-0">
              <form 
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!signerEmail.trim()) {
                    onShowToast('⚠️ Signer email is required');
                    return;
                  }
                  if (isFx) {
                    handleDispatch();
                  } else {
                    setActiveStep('self_sign');
                  }
                }} 
                className="flex-1 flex flex-col gap-6"
              >
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider w-fit">
                    Step 1 of {isFx ? '2' : '4'}
                  </span>
                  <h3 className="text-xl font-black text-slate-800 tracking-tight">Recipient Details</h3>
                  <p className="text-xs text-slate-400 font-semibold leading-relaxed">
                    Identify the counterparty below. This will configure trade transmission and e-signature routing.
                  </p>
                </div>

                <div className="flex flex-col gap-5 mt-2">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="signer-name" className="text-xs font-black text-slate-500 uppercase tracking-widest">
                      Counterparty Representative Name
                    </label>
                    <input
                      type="text"
                      id="signer-name"
                      value={signerName}
                      onChange={(e) => setSignerName(e.target.value)}
                      placeholder="e.g. John Doe"
                      autoComplete="off"
                      className="w-full px-4.5 py-3.5 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label htmlFor="signer-email" className="text-xs font-black text-slate-500 uppercase tracking-widest">
                      Counterparty Corporate Email *
                    </label>
                    <input
                      type="email"
                      id="signer-email"
                      required
                      value={signerEmail}
                      onChange={(e) => setSignerEmail(e.target.value)}
                      placeholder="e.g. jdoe@firm.com"
                      autoComplete="off"
                      className="w-full px-4.5 py-3.5 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <label htmlFor="custom-msg" className="text-xs font-black text-slate-500 uppercase tracking-widest">
                      Custom Message / Note
                    </label>
                    <textarea
                      id="custom-msg"
                      rows={4}
                      value={customMessage}
                      onChange={(e) => setCustomMessage(e.target.value)}
                      placeholder="Enter a friendly delivery note to accompany the email delivery..."
                      className="w-full px-4.5 py-3.5 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800 resize-none"
                    />
                  </div>

                  {!isFx && (
                    <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100 flex items-start gap-3 mt-1">
                      <span className="text-lg leading-none mt-0.5">✍️</span>
                      <div>
                        <p className="text-xs font-bold text-indigo-900 leading-tight">E-Signature Requirements</p>
                        <p className="text-[10.5px] text-indigo-600/80 font-medium leading-relaxed mt-1">
                          This asset class requires double-party execution. Next, you will sign your banker portion natively on the screen.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-auto pt-6">
                  <button
                    type="submit"
                    className="w-full py-4.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-xl shadow-indigo-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] cursor-pointer font-inter"
                  >
                    {isFx ? (
                      <>
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                        Send Confirmation Email
                      </>
                    ) : (
                      <>
                        Configure Local Signature
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ==================== STEP 2: BANKER LOCAL SIGNING (DRAG-AND-DROP CANVAS) ==================== */}
        {activeStep === 'self_sign' && !isFx && (
          <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch animate-fade-in">
            {/* Left Panel: Draggable Overlay PDF Viewer */}
            <div 
              onMouseMove={onDragMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
              onClick={() => setSelectedFieldId(null)}
              className="flex-1 w-full h-[650px] sm:h-[750px] lg:h-[800px] bg-slate-50 border border-slate-100 rounded-3xl relative shadow-inner overflow-hidden select-none animate-fade-in"
            >
              {/* PDF Previewer */}
              <div className="w-full h-full pointer-events-none">
                <CustomPDFViewer
                  pdfUrl={pdfUrl}
                  filename={pdfFilename || 'Confirmation'}
                  onClose={onClose}
                  onDownload={() => {}}
                  onPrint={() => {}}
                  isAiCreated={false}
                  hasExistingReport={false}
                  hideSidebar={true}
                  hideToolbar={true}
                />
              </div>

              {/* Guide Overlay Banner */}
              <div className="absolute top-4 left-4 right-4 bg-slate-900/90 backdrop-blur-sm px-5 py-3 rounded-2xl border border-slate-800 text-white flex items-center justify-between shadow-lg z-20">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🎯</span>
                  <span className="text-xs font-semibold leading-none">
                    Drag and place e-sign boxes anywhere on the PDF! Click a box to edit its value on the right.
                  </span>
                </div>
              </div>

              {/* Dynamic Drag-and-Drop Fields */}
              {placedFields.map((field) => {
                const isSelected = selectedFieldId === field.id;
                const isSig = field.type === 'signature';
                
                return (
                  <div
                    key={field.id}
                    onMouseDown={(e) => startDrag(e, field.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFieldId(field.id);
                    }}
                    style={{
                      position: 'absolute',
                      left: `${field.x}%`,
                      top: `${field.y}%`,
                      cursor: activeDragId === field.id ? 'grabbing' : 'grab',
                      border: isSelected 
                        ? `2px solid ${isSig ? '#f59e0b' : '#6366f1'}` 
                        : `1.5px dashed ${isSig ? '#d97706' : '#818cf8'}`,
                      padding: isSig ? '4px' : '6px 10px',
                      borderRadius: '10px',
                      backgroundColor: isSig 
                        ? 'rgba(254, 243, 199, 0.88)' // warm transparent amber
                        : 'rgba(238, 242, 255, 0.88)', // premium transparent indigo
                      backdropFilter: 'blur(4px)',
                      zIndex: isSelected ? 40 : 30,
                      width: isSig ? '160px' : '200px',
                      minHeight: isSig ? '70px' : 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      transition: activeDragId === field.id ? 'none' : 'box-shadow 0.2s, border-color 0.2s'
                    }}
                    className={`shadow-md hover:shadow-lg select-none group ${isSelected ? 'ring-2 ring-indigo-500/20' : ''}`}
                  >
                    {isSig ? (
                      field.value ? (
                        <img 
                          src={field.value} 
                          alt="Signature Stamp" 
                          className="max-w-full max-h-[56px] object-contain pointer-events-none mx-auto" 
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center py-2 text-slate-400 gap-1">
                          <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                          <span className="text-[9px] font-black text-amber-600/80 uppercase tracking-wide">Draw Signature</span>
                        </div>
                      )
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[7.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
                          {field.label}
                        </span>
                        <span className="text-[11px] font-bold text-slate-900 font-mono break-words leading-tight mt-0.5">
                          {field.value || <em className="text-slate-300 font-normal">No text configured</em>}
                        </span>
                      </div>
                    )}
                    
                    {/* Role / Pill Badge */}
                    <span className={`text-[7px] text-white font-extrabold px-1.5 py-0.5 rounded absolute -top-2.5 right-2 uppercase tracking-wider scale-90 ${
                      isSig ? 'bg-amber-500' : 'bg-indigo-600'
                    }`}>
                      {field.label}
                    </span>

                    {/* Delete button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlacedFields(prev => prev.filter(f => f.id !== field.id));
                        if (selectedFieldId === field.id) setSelectedFieldId(null);
                      }}
                      className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-rose-500 text-white flex items-center justify-center text-[10px] font-black opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-rose-600 cursor-pointer"
                      title="Delete Field"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Right Panel: Banker Drawing Pad & Acrobat Style Toolbox */}
            <div className="w-full xl:w-[460px] bg-white border border-slate-100 rounded-3xl shadow-xl flex flex-col p-6 sm:p-8 min-w-0 shrink-0 gap-5 overflow-y-auto">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider w-fit">
                  Step 2 of 4
                </span>
                <h3 className="text-xl font-black text-slate-800 tracking-tight">Banker Signature Editor</h3>
                <p className="text-xs text-slate-400 font-semibold leading-relaxed">
                  Design and position your individual signing elements exactly like an Acrobat editor.
                </p>
              </div>

              {/* 1. Acrobat Toolbox */}
              <div className="border border-slate-100 bg-slate-50/50 p-4.5 rounded-2xl flex flex-col gap-3">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                  🛠️ Drag & Drop Fields Toolbox
                </span>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    onClick={() => addField('text')}
                    className="py-2.5 px-3 bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200/80 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-sm hover:border-indigo-200"
                  >
                    📝 + Custom Text
                  </button>
                  <button
                    onClick={() => addField('signature')}
                    className="py-2.5 px-3 bg-white hover:bg-amber-50 text-amber-600 border border-slate-200/80 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-sm hover:border-amber-200"
                  >
                    ✍️ + Signature Pad
                  </button>
                  <button
                    onClick={() => addField('name')}
                    className="py-2.5 px-3 bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200/80 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-sm hover:border-indigo-200"
                  >
                    👤 + Banker Name
                  </button>
                  <button
                    onClick={() => addField('title')}
                    className="py-2.5 px-3 bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200/80 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer shadow-sm hover:border-indigo-200"
                  >
                    💼 + Corp Title
                  </button>
                  <button
                    onClick={() => addField('date')}
                    className="py-2.5 px-3 bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200/80 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer col-span-2 shadow-sm hover:border-indigo-200"
                  >
                    📅 + Todays Date stamp
                  </button>
                </div>
              </div>

              {/* 2. Signature Drawing Canvas Card */}
              <div className="border border-slate-100 p-4.5 rounded-2xl flex flex-col gap-2">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                  🖊️ Drawn Ink Signature
                </span>
                <div className="w-full h-[140px] bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl overflow-hidden relative shadow-inner mt-1">
                  <canvas
                    ref={canvasRef}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawingTouch}
                    onTouchMove={drawTouch}
                    onTouchEnd={stopDrawing}
                    className="w-full h-full cursor-crosshair bg-white"
                  />
                  <button
                    onClick={clearCanvas}
                    type="button"
                    className="absolute bottom-2.5 right-2.5 px-2.5 py-1.5 bg-slate-900/80 hover:bg-slate-900 text-white text-[9px] font-bold rounded-lg transition-all cursor-pointer"
                  >
                    Clear Pad
                  </button>
                </div>
                <button
                  onClick={acceptSignature}
                  type="button"
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition-all cursor-pointer mt-1"
                >
                  Capture & Update Signature Stamp
                </button>
              </div>

              {/* 3. Selected Field Properties Editor */}
              {selectedField ? (
                <div className="border border-indigo-100 bg-indigo-50/20 p-4.5 rounded-2xl flex flex-col gap-3 animate-fade-in">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider scale-95 leading-none">
                      Selected: {selectedField.label}
                    </span>
                    <button
                      onClick={() => {
                        setPlacedFields(prev => prev.filter(f => f.id !== selectedFieldId));
                        setSelectedFieldId(null);
                      }}
                      className="text-[10px] font-bold text-rose-500 hover:text-rose-600 transition-colors cursor-pointer"
                    >
                      Delete Field
                    </button>
                  </div>
                  {selectedField.type !== 'signature' ? (
                    <div className="flex flex-col gap-1.5 mt-1">
                      <label htmlFor="prop-val" className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">
                        Field Stamped Value
                      </label>
                      <input
                        type="text"
                        id="prop-val"
                        value={selectedField.value}
                        onChange={(e) => updateSelectedFieldValue(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-xs font-bold text-slate-800 bg-white"
                      />
                    </div>
                  ) : (
                    <p className="text-[10px] text-slate-400 font-semibold leading-relaxed mt-1">
                      Signature coordinates are dynamically controlled. Re-draw and capture on the pad above to update the digital stroke.
                    </p>
                  )}
                </div>
              ) : (
                <div className="p-4 bg-slate-50 border border-slate-100 border-dashed rounded-2xl flex items-center justify-center text-center text-[10.5px] font-bold text-slate-400 py-6">
                  💡 Select any field on the document to edit its contents in real time.
                </div>
              )}

              {/* Execution Actions */}
              <div className="mt-auto pt-4 flex flex-col gap-2 shrink-0">
                <button
                  onClick={handleLocalStamping}
                  disabled={loading || !signatureImage}
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-xl shadow-indigo-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-inter"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Stitching Signature...
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                      Apply & Stitch Signature
                    </>
                  )}
                </button>
                
                <button
                  onClick={() => setActiveStep('recipient')}
                  className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors text-center"
                >
                  Back to Recipient Setup
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ==================== STEP 3: PLACE FIELDS (SPACIOUS BUILDER) ==================== */}
        {activeStep === 'place_fields' && !isFx && (
          <div className="flex-1 flex flex-col gap-4 animate-fade-in">
            {/* Full-screen dominant builder space */}
            <div className="bg-indigo-50/40 border border-indigo-100/50 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-inner">
              <div className="flex items-start sm:items-center gap-2">
                <span className="text-xl">🛠️</span>
                <div>
                  <h4 className="text-xs font-black text-indigo-900">Step 3 of 4: Client signature Placeholders</h4>
                  <p className="text-[11px] text-indigo-700/80 font-medium">
                    Drag the Client's signature boxes onto the document template below. Since your signature is already permanently stamped on the PDF, there is only one role to configure: <strong>Client</strong>.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setActiveStep('self_sign')}
                  className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-600 rounded-xl text-xs font-bold transition-all border border-slate-200 cursor-pointer"
                >
                  ⬅️ Back to Banker Sign
                </button>
                <button
                  onClick={handleDispatch}
                  disabled={loading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center gap-1.5 cursor-pointer font-inter"
                >
                  {loading ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Dispatching...
                    </>
                  ) : (
                    <>
                      Send to Client
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Expansive Builder Area */}
            <div className="w-full h-[750px] sm:h-[850px] lg:h-[950px] bg-slate-50 border border-slate-200/60 rounded-3xl overflow-hidden relative shadow-md">
              {builderToken && scriptLoaded ? (
                React.createElement('docuseal-builder', {
                  'data-token': builderToken,
                  'class': 'w-full h-full border-none'
                })
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-4 bg-slate-50">
                  <div className="w-10 h-10 border-4 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                    Spawning Secure Template Editor...
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== STEP 4 / COMPLETE STATE ==================== */}
        {activeStep === 'complete' && (
          <div className="flex-1 flex items-center justify-center p-6 animate-fade-in select-none">
            <div className="w-full max-w-[500px] bg-white border border-slate-100 rounded-[36px] shadow-2xl p-8 sm:p-10 flex flex-col items-center text-center gap-6 relative overflow-hidden">
              {/* Decorative premium glass pattern */}
              <div className="absolute -top-24 -right-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl" />
              <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl" />

              <div className="w-20 h-20 rounded-[28px] bg-emerald-50 text-emerald-500 flex items-center justify-center text-4xl shadow-xl shadow-emerald-500/10 animate-bounce mt-4 relative z-10">
                🎉
              </div>

              <div className="flex flex-col gap-2 relative z-10">
                <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full uppercase tracking-wider w-fit mx-auto">
                  Completed
                </span>
                <h3 className="text-2xl font-black text-slate-800 tracking-tight mt-1">Trade Dispatch Complete</h3>
                <p className="text-xs text-slate-400 font-semibold leading-relaxed px-4">
                  {isFx 
                    ? 'The FX NDF Trade Confirmation has been emailed directly and archived successfully in the legal vaults.'
                    : 'The signature request has been dispatched. The trade will be archived automatically once signed.'
                  }
                </p>
              </div>

              {!isFx && counterpartySignUrl && (
                <div className="w-full bg-slate-50 p-4.5 rounded-2xl border border-slate-200/50 flex flex-col gap-2.5 text-left relative z-10">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                      Client Signature Link (Backup)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={counterpartySignUrl}
                      className="flex-1 bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs text-slate-500 font-semibold truncate outline-none"
                    />
                    <button
                      onClick={handleCopyLink}
                      className="px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col w-full gap-3 mt-4 relative z-10">
                <button
                  onClick={onClose}
                  className="w-full py-4.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-2xl shadow-xl text-sm transition-all active:scale-[0.98] cursor-pointer"
                >
                  Back to My Documents
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
