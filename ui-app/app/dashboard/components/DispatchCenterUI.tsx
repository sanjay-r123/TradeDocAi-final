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

const LocalSigningCanvas = dynamic(() => import('./LocalSigningCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-[600px] h-[800px] bg-white animate-pulse flex flex-col items-center justify-center gap-3 shadow rounded-3xl">
      <div className="w-8 h-8 border-4 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Loading PDF Page...</p>
    </div>
  ),
});

interface PlacedField {
  id: string;
  type: 'signature' | 'name' | 'title' | 'date' | 'text';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  value: string;
  fontSize?: number;
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
    { id: 'sig', type: 'signature', label: 'Signature', x: 25, y: 78, w: 16, h: 8, value: '' },
    { id: 'name', type: 'name', label: 'Signatory Name', x: 45, y: 76, w: 22, h: 5, value: 'Sanjay R' },
    { id: 'title', type: 'title', label: 'Corporate Title', x: 45, y: 81, w: 22, h: 5, value: 'Managing Director' },
    { id: 'date', type: 'date', label: 'Signing Date', x: 45, y: 86, w: 22, h: 5, value: new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) }
  ]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Acrobat Tools State
  const [selectedTool, setSelectedTool] = useState<'text' | 'signature' | 'date' | null>(null);
  const [activeResizeId, setActiveResizeId] = useState<string | null>(null);
  const [resizeHandle, setResizeHandle] = useState<'tl' | 'tr' | 'bl' | 'br' | null>(null);
  const [showSigModal, setShowSigModal] = useState(false);
  const [sigModalTab, setSigModalTab] = useState<'draw' | 'upload' | 'type'>('draw');
  const [typedName, setTypedName] = useState('Sanjay R');
  const [pendingSigCoords, setPendingSigCoords] = useState<{ x: number, y: number } | null>(null);

  // Dynamically load elegant handwriting fonts for type-to-sign signatures
  useEffect(() => {
    const linkId = 'cursive-signatures-font-link';
    if (!document.getElementById(linkId)) {
      const link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Alex+Brush&family=Dancing+Script:wght@700&family=Great+Vibes&family=Playball&display=swap';
      document.head.appendChild(link);
    }
  }, []);

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
    saveSignatureData(dataUrl);
    onShowToast('📋 Signature captured successfully!');
  };

  const acceptTypedSignature = (text: string, fontName: string) => {
    if (!text.trim()) {
      onShowToast('⚠️ Please type your signature text first');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 150;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1e1b4b'; // elegant dark navy signature ink
    ctx.font = `56px "${fontName}", cursive`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    
    const dataUrl = canvas.toDataURL('image/png');
    saveSignatureData(dataUrl);
    setShowSigModal(false);
    onShowToast('✍️ Calligraphic signature generated!');
  };

  const saveSignatureData = (dataUrl: string) => {
    setSignatureImage(dataUrl);
    // Apply signature to signature fields in layout
    setPlacedFields(prev => prev.map(f => f.type === 'signature' ? { ...f, value: dataUrl } : f));
    
    // If we had a click waiting for signature, place it now
    if (pendingSigCoords) {
      placeSignatureAtCoords(dataUrl, pendingSigCoords.x, pendingSigCoords.y);
      setPendingSigCoords(null);
    }
  };

  const placeSignatureAtCoords = (dataUrl: string, px: number, py: number) => {
    const id = `sig_${Date.now()}`;
    const width = 16;
    const height = 8;
    const newField: PlacedField = {
      id,
      type: 'signature',
      label: 'Signature',
      x: Math.max(0, Math.min(100 - width, px - width / 2)),
      y: Math.max(0, Math.min(100 - height, py - height / 2)),
      w: width,
      h: height,
      value: dataUrl
    };
    setPlacedFields(prev => [...prev.filter(f => f.type !== 'signature' || f.value !== ''), newField]);
    setSelectedFieldId(id);
    onShowToast('✍️ Signature stamped on the document!');
  };

  const handleSignatureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      saveSignatureData(result);
      setShowSigModal(false);
      onShowToast('📥 Signature image uploaded successfully!');
    };
    reader.readAsDataURL(file);
  };

  // Acrobat Click-to-Place Tool Spawner
  const addFieldAtPosition = (type: 'signature' | 'text' | 'date', px: number, py: number) => {
    const id = `${type}_${Date.now()}`;
    let label = '';
    let defaultValue = '';
    let width = 22;
    let height = 5;
    
    switch (type) {
      case 'signature':
        label = 'Signature';
        defaultValue = signatureImage || '';
        width = 16;
        height = 8;
        if (!signatureImage) {
          setShowSigModal(true);
          setPendingSigCoords({ x: px, y: py });
          setSelectedTool(null);
          return;
        }
        break;
      case 'date':
        label = 'Signing Date';
        defaultValue = stampedDate;
        width = 22;
        height = 4.5;
        break;
      case 'text':
        label = 'Custom Text';
        defaultValue = 'Enter text here';
        width = 22;
        height = 4.5;
        break;
    }
    
    const newField: PlacedField = {
      id,
      type: type === 'text' ? 'text' : (type === 'date' ? 'date' : 'signature'),
      label,
      x: Math.max(0, Math.min(100 - width, px - width / 2)),
      y: Math.max(0, Math.min(100 - height, py - height / 2)),
      w: width,
      h: height,
      value: defaultValue,
      fontSize: 11
    };
    
    setPlacedFields(prev => [...prev, newField]);
    setSelectedFieldId(id);
    setSelectedTool(null); // Reset active tool (Acrobat default)
    onShowToast(`➕ Placed ${label}! Drag corners to resize.`);
  };

  // Traditional Sidebar Spawner (Acrobat Toolbar Fallback)
  const addField = (type: 'signature' | 'name' | 'title' | 'date' | 'text') => {
    const id = `${type}_${Date.now()}`;
    let label = '';
    let defaultValue = '';
    let width = 22;
    let height = 5;
    
    switch (type) {
      case 'signature':
        label = 'Signature';
        defaultValue = signatureImage || '';
        width = 16;
        height = 8;
        if (!signatureImage) {
          setShowSigModal(true);
          setSelectedTool(null);
          return;
        }
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
    
    const newField: PlacedField = {
      id,
      type,
      label,
      x: 35 + (placedFields.length * 4) % 25,
      y: 40 + (placedFields.length * 5) % 25,
      w: width,
      h: height,
      value: defaultValue,
      fontSize: 11
    };
    
    setPlacedFields(prev => [...prev, newField]);
    setSelectedFieldId(id);
    onShowToast(`➕ Added ${label} field. Drag to place!`);
  };

  const updateSelectedFieldValue = (val: string) => {
    if (!selectedFieldId) return;
    setPlacedFields(prev => prev.map(f => f.id === selectedFieldId ? { ...f, value: val } : f));
    const field = placedFields.find(f => f.id === selectedFieldId);
    if (field) {
      if (field.type === 'name') setBankerName(val);
      if (field.type === 'title') setBankerTitle(val);
    }
  };

  // Draggable & Resizable Handlers
  const onDragMove = (e: React.MouseEvent) => {
    if (!activeDragId && !activeResizeId) return;
    const container = e.currentTarget.getBoundingClientRect();
    
    const deltaX = ((e.clientX - dragStart.x) / container.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / container.height) * 100;
    
    if (activeDragId) {
      setPlacedFields(prev => prev.map(field => {
        if (field.id === activeDragId) {
          return {
            ...field,
            x: Math.max(0, Math.min(100 - field.w, field.x + deltaX)),
            y: Math.max(0, Math.min(100 - field.h, field.y + deltaY))
          };
        }
        return field;
      }));
      setDragStart({ x: e.clientX, y: e.clientY });
    } else if (activeResizeId && resizeHandle) {
      setPlacedFields(prev => prev.map(field => {
        if (field.id === activeResizeId) {
          let newW = field.w;
          let newH = field.h;
          let newX = field.x;
          let newY = field.y;

          if (resizeHandle === 'br') {
            newW = Math.max(4, Math.min(100 - field.x, field.w + deltaX));
            newH = Math.max(2, Math.min(100 - field.y, field.h + deltaY));
          } else if (resizeHandle === 'bl') {
            const possibleW = field.w - deltaX;
            if (possibleW >= 4) {
              newX = Math.max(0, field.x + deltaX);
              newW = possibleW;
            }
            newH = Math.max(2, Math.min(100 - field.y, field.h + deltaY));
          } else if (resizeHandle === 'tr') {
            newW = Math.max(4, Math.min(100 - field.x, field.w + deltaX));
            const possibleH = field.h - deltaY;
            if (possibleH >= 2) {
              newY = Math.max(0, field.y + deltaY);
              newH = possibleH;
            }
          } else if (resizeHandle === 'tl') {
            const possibleW = field.w - deltaX;
            if (possibleW >= 4) {
              newX = Math.max(0, field.x + deltaX);
              newW = possibleW;
            }
            const possibleH = field.h - deltaY;
            if (possibleH >= 2) {
              newY = Math.max(0, field.y + deltaY);
              newH = possibleH;
            }
          }

          // Lock aspect ratio for signature stamps (e.g. 2:1 ratio)
          if (field.type === 'signature') {
            newH = newW / 2;
          }

          return {
            ...field,
            x: newX,
            y: newY,
            w: newW,
            h: newH
          };
        }
        return field;
      }));
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const startDrag = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    // Only drag if not clicking floating controls or corner handles
    if (activeResizeId) return;
    setActiveDragId(id);
    setSelectedFieldId(id);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const startResize = (e: React.MouseEvent, id: string, handle: 'tl' | 'tr' | 'bl' | 'br') => {
    e.stopPropagation();
    e.preventDefault();
    setActiveResizeId(id);
    setResizeHandle(handle);
    setSelectedFieldId(id);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const endDrag = () => {
    setActiveDragId(null);
    setActiveResizeId(null);
    setResizeHandle(null);
  };

  // Stamping and Saving locally using PyMuPDF
  const handleLocalStamping = async () => {
    let sigField = placedFields.find(f => f.type === 'signature');
    let sigBase64 = signatureImage || '';
    let sigX = -0.5;
    let sigY = -0.5;
    let sigW = 0.001;
    let sigH = 0.001;

    if (sigField && sigField.value) {
      sigBase64 = sigField.value;
      sigX = sigField.x / 100;
      sigY = sigField.y / 100;
      sigW = sigField.w / 100;
      sigH = sigField.h / 100;
    } else {
      // Bypasses backend schema requirements with a transparent 1x1 pixel PNG out of bounds
      sigBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
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
        sig_x_pct: sigX,
        sig_y_pct: sigY,
        sig_w_pct: sigW,
        sig_h_pct: sigH,
        signature_base64: sigBase64,
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

        {/* ==================== STEP 2: BANKER LOCAL SIGNING (ACROBAT CLICK-TO-PLACE EDITOR) ==================== */}
        {activeStep === 'self_sign' && !isFx && (
          <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch animate-fade-in">
            {/* Left Panel: Acrobat Placement Canvas & PDF Viewer */}
            <LocalSigningCanvas
              pdfUrl={pdfUrl}
              selectedTool={selectedTool}
              setSelectedTool={setSelectedTool}
              placedFields={placedFields}
              setPlacedFields={setPlacedFields}
              selectedFieldId={selectedFieldId}
              setSelectedFieldId={setSelectedFieldId}
              activeDragId={activeDragId}
              activeResizeId={activeResizeId}
              onDragMove={onDragMove}
              endDrag={endDrag}
              startDrag={startDrag}
              startResize={startResize}
              addFieldAtPosition={addFieldAtPosition}
              signatureImage={signatureImage}
              setShowSigModal={setShowSigModal}
              setPendingSigCoords={setPendingSigCoords}
            />

            {/* Right Panel: Side Panel controls & Properties Editor */}
            <div className="w-full xl:w-[460px] bg-white border border-slate-100 rounded-3xl shadow-xl flex flex-col p-6 sm:p-8 min-w-0 shrink-0 gap-5 overflow-y-auto select-none">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider w-fit">
                  Step 2 of 4
                </span>
                <h3 className="text-xl font-black text-slate-800 tracking-tight">Banker Signature Editor</h3>
                <p className="text-xs text-slate-400 font-semibold leading-relaxed">
                  Design and position your individual signing elements exactly like an Acrobat editor.
                </p>
              </div>

              {/* Direct Field Properties Editor */}
              {selectedField ? (
                <div className="border border-indigo-100 bg-indigo-50/25 p-4.5 rounded-2xl flex flex-col gap-3.5 animate-fade-in shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider scale-95 leading-none">
                      Active: {selectedField.label}
                    </span>
                    <button
                      type="button"
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
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="prop-val" className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">
                        Field Stamped Value
                      </label>
                      <input
                        type="text"
                        id="prop-val"
                        value={selectedField.value}
                        onChange={(e) => updateSelectedFieldValue(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-xs font-bold text-slate-800 bg-white"
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <p className="text-[10px] text-slate-400 font-semibold leading-relaxed">
                        Signature stamp is placed. You can adjust its size by dragging the corner handles on the document viewer or upload a scan.
                      </p>
                      <button
                        type="button"
                        onClick={() => { setShowSigModal(true); setSigModalTab('upload'); }}
                        className="w-fit py-1.5 px-3 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200/80 rounded-xl text-[10px] font-bold transition-all shadow-sm flex items-center gap-1 cursor-pointer"
                      >
                        📥 Upload New Scan Image
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-5 bg-slate-50 border border-slate-100 border-dashed rounded-2xl flex flex-col items-center justify-center text-center py-8 gap-1.5">
                  <span className="text-xl">💡</span>
                  <p className="text-[10.5px] font-bold text-slate-400 max-w-[240px]">
                    Select a tool in the floating toolbar, click the document to place it, and adjust values here.
                  </p>
                </div>
              )}

              {/* Saved Signature Panel */}
              <div className="border border-slate-100 p-4.5 rounded-2xl flex flex-col gap-2.5">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                  🖊️ Configured Signature Ink
                </span>
                {signatureImage ? (
                  <div className="flex flex-col gap-2">
                    <div className="w-full h-[100px] bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center p-3 relative overflow-hidden shadow-inner mt-1">
                      <img src={signatureImage} alt="Saved Signature" className="max-w-full max-h-full object-contain pointer-events-none" />
                      <button
                        type="button"
                        onClick={() => { setSignatureImage(null); setPlacedFields(prev => prev.map(f => f.type === 'signature' ? { ...f, value: '' } : f)); }}
                        className="absolute top-2 right-2 bg-rose-50 hover:bg-rose-100 text-rose-500 rounded p-1 cursor-pointer text-[10px] font-bold"
                      >
                        Clear
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setShowSigModal(true); setSigModalTab('draw'); }}
                      className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition-all cursor-pointer"
                    >
                      🔄 Configure Signature Stamp
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setShowSigModal(true); setSigModalTab('draw'); }}
                    className="w-full py-4.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 border-dashed text-slate-500 rounded-2xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-2 cursor-pointer py-6 shadow-sm mt-1"
                  >
                    <span className="text-xl">🖊️</span>
                    Setup Banker Signature
                  </button>
                )}
              </div>

              {/* Execution Actions */}
              <div className="mt-auto pt-4 flex flex-col gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleLocalStamping}
                  disabled={loading}
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-xl shadow-indigo-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer font-inter"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Stitching Document...
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                      Apply Changes & Proceed
                    </>
                  )}
                </button>
                
                <button
                  type="button"
                  onClick={() => setActiveStep('recipient')}
                  className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors text-center"
                >
                  Back to Recipient Setup
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global Draw/Upload/Type Signature Modal Settings Dialog */}
        {showSigModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
            <div className="w-full max-w-[480px] bg-white rounded-[32px] shadow-2xl p-6 flex flex-col gap-5 border border-slate-100 overflow-hidden relative">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h4 className="text-base font-black text-slate-800 tracking-tight">Configure E-Signature Stamp</h4>
                <button 
                  type="button"
                  onClick={() => { setShowSigModal(false); setPendingSigCoords(null); }}
                  className="text-slate-400 hover:text-slate-600 text-lg font-bold p-1 cursor-pointer"
                >
                  ×
                </button>
              </div>

              {/* Tabs */}
              <div className="flex bg-slate-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => setSigModalTab('draw')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                    sigModalTab === 'draw' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  🖊️ Draw Stroke
                </button>
                <button
                  type="button"
                  onClick={() => setSigModalTab('type')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                    sigModalTab === 'type' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  ✍️ Type Signature
                </button>
                <button
                  type="button"
                  onClick={() => setSigModalTab('upload')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                    sigModalTab === 'upload' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📥 Upload Scan / PNG
                </button>
              </div>

              {sigModalTab === 'draw' && (
                <div className="flex flex-col gap-4">
                  <div className="w-full h-[200px] bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl overflow-hidden relative shadow-inner">
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
                      className="absolute bottom-3 right-3 px-3 py-1.5 bg-slate-900/80 hover:bg-slate-900 text-white text-[10px] font-bold rounded-lg transition-all cursor-pointer"
                    >
                      Clear Pad
                    </button>
                  </div>
                  <button
                    onClick={acceptSignature}
                    type="button"
                    className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md shadow-indigo-600/10 font-inter"
                  >
                    Save & Stencil Signature
                  </button>
                </div>
              )}

              {sigModalTab === 'type' && (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="typed-name-val" className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                      Type Your Name
                    </label>
                    <input
                      type="text"
                      id="typed-name-val"
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      placeholder="e.g. Sanjay R"
                      className="w-full px-3.5 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-bold text-slate-800 bg-white"
                    />
                  </div>

                  <div className="flex flex-col gap-2.5 mt-2">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
                      Select Cursive Style
                    </span>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => acceptTypedSignature(typedName, 'Great Vibes')}
                        style={{ fontFamily: "'Great Vibes', cursive" }}
                        className="p-4 bg-slate-50 border border-slate-200 hover:border-indigo-500 rounded-2xl text-xl font-medium transition-all text-slate-800 hover:bg-indigo-50/20 cursor-pointer text-center truncate"
                      >
                        {typedName || 'Sanjay R'}
                      </button>
                      <button
                        type="button"
                        onClick={() => acceptTypedSignature(typedName, 'Dancing Script')}
                        style={{ fontFamily: "'Dancing Script', cursive" }}
                        className="p-4 bg-slate-50 border border-slate-200 hover:border-indigo-500 rounded-2xl text-xl font-bold transition-all text-slate-800 hover:bg-indigo-50/20 cursor-pointer text-center truncate"
                      >
                        {typedName || 'Sanjay R'}
                      </button>
                      <button
                        type="button"
                        onClick={() => acceptTypedSignature(typedName, 'Alex Brush')}
                        style={{ fontFamily: "'Alex Brush', cursive" }}
                        className="p-4 bg-slate-50 border border-slate-200 hover:border-indigo-500 rounded-2xl text-2xl font-normal transition-all text-slate-800 hover:bg-indigo-50/20 cursor-pointer text-center truncate"
                      >
                        {typedName || 'Sanjay R'}
                      </button>
                      <button
                        type="button"
                        onClick={() => acceptTypedSignature(typedName, 'Playball')}
                        style={{ fontFamily: "'Playball', cursive" }}
                        className="p-4 bg-slate-50 border border-slate-200 hover:border-indigo-500 rounded-2xl text-xl font-normal transition-all text-slate-800 hover:bg-indigo-50/20 cursor-pointer text-center truncate"
                      >
                        {typedName || 'Sanjay R'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {sigModalTab === 'upload' && (
                <div className="flex flex-col gap-4">
                  <div className="w-full h-[200px] border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-2xl flex flex-col items-center justify-center p-6 text-center bg-slate-50/50 hover:bg-indigo-50/20 transition-all cursor-pointer relative group">
                    <input
                      type="file"
                      accept="image/png, image/jpeg, image/jpg"
                      onChange={handleSignatureUpload}
                      className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    />
                    <span className="text-3xl text-slate-400 group-hover:scale-110 transition-transform">📁</span>
                    <span className="text-xs font-black text-slate-600 mt-2">Click to Upload Signature File</span>
                    <span className="text-[10px] text-slate-400 font-semibold mt-1">Supports transparent PNG, JPEG, or scanned JPGs</span>
                  </div>
                  <div className="text-center text-[10px] text-slate-400 italic">
                    💡 Scanning or taking a high-contrast photo of your signature works perfectly.
                  </div>
                </div>
              )}
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
