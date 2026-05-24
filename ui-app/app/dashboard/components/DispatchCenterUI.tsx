'use client';

import React, { useState, useEffect } from 'react';
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
  const [builderToken, setBuilderToken] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const [senderSignUrl, setSenderSignUrl] = useState<string | null>(null);
  const [counterpartySignUrl, setCounterpartySignUrl] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<'recipient' | 'place_fields' | 'self_sign' | 'complete'>('recipient');
  const [copied, setCopied] = useState(false);

  const isFx = activeSchema.id === 'fx_ndf';

  // Load DocuSeal builder script and fetch JWT token
  useEffect(() => {
    if (isFx) return; // FX doesn't use DocuSeal template builder
    
    // Load script dynamically
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

    // Fetch token from backend
    const fetchToken = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/documents/${docId}/builder-token`, {
          headers: authHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          setBuilderToken(data.token);
        } else {
          onShowToast('⚠️ Failed to load template builder workspace');
        }
      } catch (e) {
        onShowToast('❌ Network error loading template builder workspace');
      }
    };
    fetchToken();
  }, [docId, isFx, onShowToast]);

  const handleDispatch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!signerEmail.trim()) {
      onShowToast('⚠️ Signer email is required');
      return;
    }

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
        setSenderSignUrl(result.sender_sign_url);
        setCounterpartySignUrl(result.counterparty_sign_url);
        onShowToast('✍️ E-signature workflow successfully initialized!');
        setActiveStep('self_sign');
      }
    } catch {
      onShowToast('❌ Network error during dispatch');
    }
    setLoading(false);
  };

  const handleCloseDocument = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/documents/${docId}/close`, {
        method: 'POST',
        headers: authHeaders(),
      });

      if (response.ok) {
        onShowToast('🔒 Document closed and archived successfully!');
        onFetchRecentDocs();
        onClose();
      } else {
        onShowToast('⚠️ Make sure both parties have signed before closing.');
      }
    } catch {
      onShowToast('❌ Failed to close document');
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

      {/* Spacious Step Progress tracker */}
      <div className="flex items-center justify-between bg-slate-50 border border-slate-100/80 p-4 rounded-3xl mb-2 shadow-sm select-none">
        <div className="flex items-center justify-around w-full max-w-4xl mx-auto px-4 gap-4">
          
          {/* Step 1 Indicator */}
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
              activeStep === 'recipient' 
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                : ['place_fields', 'self_sign', 'complete'].includes(activeStep)
                  ? 'bg-emerald-500 text-white'
                  : 'bg-slate-200 text-slate-500'
            }`}>
              {['place_fields', 'self_sign', 'complete'].includes(activeStep) ? '✓' : '1'}
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
              
              {/* Step 2 Indicator */}
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                  activeStep === 'place_fields' 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                    : ['self_sign', 'complete'].includes(activeStep)
                      ? 'bg-emerald-500 text-white'
                      : 'bg-slate-200 text-slate-500'
                }`}>
                  {['self_sign', 'complete'].includes(activeStep) ? '✓' : '2'}
                </div>
                <span className={`text-xs font-bold transition-colors hidden sm:inline ${
                  activeStep === 'place_fields' ? 'text-indigo-600 font-black' : 'text-slate-500'
                }`}>
                  Place Fields
                </span>
              </div>

              <div className="flex-1 h-0.5 max-w-[60px] bg-slate-200 rounded-full" />
              
              {/* Step 3 Indicator */}
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                  activeStep === 'self_sign' 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-50' 
                    : activeStep === 'complete'
                      ? 'bg-emerald-500 text-white'
                      : 'bg-slate-200 text-slate-500'
                }`}>
                  {activeStep === 'complete' ? '✓' : '3'}
                </div>
                <span className={`text-xs font-bold transition-colors hidden sm:inline ${
                  activeStep === 'self_sign' ? 'text-indigo-600 font-black' : 'text-slate-500'
                }`}>
                  Banker Self-Sign
                </span>
              </div>
            </>
          )}

          <div className="flex-1 h-0.5 max-w-[60px] bg-slate-200 rounded-full" />

          {/* Final Step Indicator */}
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
          <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch">
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
                    setActiveStep('place_fields');
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
                          This asset class requires double-party execution. Next, you will place tags on the template, then complete self-signing on-page.
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
                        Configure Signature Fields
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

        {/* ==================== STEP 2: PLACE FIELDS (SPACIOUS BUILDER) ==================== */}
        {activeStep === 'place_fields' && !isFx && (
          <div className="flex-1 flex flex-col gap-4 animate-fade-in">
            {/* Full-screen dominant builder space */}
            <div className="bg-indigo-50/40 border border-indigo-100/50 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-inner">
              <div className="flex items-start sm:items-center gap-2">
                <span className="text-xl">🛠️</span>
                <div>
                  <h4 className="text-xs font-black text-indigo-900">Step 2 of 4: Document Field Configurator</h4>
                  <p className="text-[11px] text-indigo-700/80 font-medium">
                    Drag and drop signature fields from the right sidebar onto the PDF page below. Tag boxes specifically for both <strong>Sender</strong> and <strong>Counterparty</strong>.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setActiveStep('recipient')}
                  className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-600 rounded-xl text-xs font-bold transition-all border border-slate-200 cursor-pointer"
                >
                  ⬅️ Back to Recipient
                </button>
                <button
                  onClick={() => handleDispatch()}
                  disabled={loading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center gap-1.5 cursor-pointer"
                >
                  {loading ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Initializing...
                    </>
                  ) : (
                    <>
                      Prepare & Sign Document
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

        {/* ==================== STEP 3: BANKER SELF-SIGNING ==================== */}
        {activeStep === 'self_sign' && !isFx && (
          <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch animate-fade-in">
            {/* Left Panel: Spacious Embedded Self-Sign frame */}
            <div className="w-full h-[650px] sm:h-[750px] lg:h-[800px] bg-slate-50 border border-slate-100 rounded-3xl overflow-hidden relative shadow-inner flex flex-col">
              <div className="bg-indigo-600 text-white px-6 py-3.5 flex items-center justify-between border-b border-indigo-700">
                <div className="flex items-center gap-2">
                  <span className="text-lg">✍️</span>
                  <span className="text-xs font-black uppercase tracking-wider">Banker Signature Pad</span>
                </div>
                <span className="text-[10px] bg-indigo-500 px-2 py-0.5 rounded font-bold uppercase">On Screen</span>
              </div>
              
              <div className="flex-1 relative bg-white">
                {senderSignUrl ? (
                  <iframe
                    src={senderSignUrl}
                    className="w-full h-full border-none"
                    title="Self-Signing Iframe"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-50">
                    <div className="w-10 h-10 border-4 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                      Generating signature pad...
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right Panel: Actions & Client links */}
            <div className="w-full xl:w-[460px] bg-white border border-slate-100 rounded-3xl shadow-xl flex flex-col p-6 sm:p-8 min-w-0 shrink-0">
              <div className="flex-1 flex flex-col gap-6">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider w-fit">
                    Step 3 of 4
                  </span>
                  <h3 className="text-xl font-black text-slate-800 tracking-tight">Sign Your Copy</h3>
                  <p className="text-xs text-slate-400 font-semibold leading-relaxed">
                    To execute this trade confirmation legally, please place and complete your signature on the left-side frame.
                  </p>
                </div>

                <div className="flex flex-col gap-4 mt-2">
                  <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200/50 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        Client Signature Link
                      </span>
                      <span className="text-[9px] font-extrabold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider">
                        Emailed
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={counterpartySignUrl || ''}
                        className="flex-1 bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs text-slate-500 font-semibold truncate outline-none select-all"
                      />
                      <button
                        onClick={handleCopyLink}
                        className="px-3.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-xl text-xs font-bold transition-all border border-indigo-100 cursor-pointer shrink-0"
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                      The counterparty has been automatically invited via Resend email, but you can copy and send this link manually as a backup.
                    </p>
                  </div>

                  <div className="bg-emerald-50/50 p-4.5 rounded-2xl border border-emerald-100 flex items-start gap-3 mt-1">
                    <span className="text-lg leading-none">🚀</span>
                    <div>
                      <p className="text-xs font-bold text-emerald-950 leading-tight">Client Invitation Dispatched</p>
                      <p className="text-[10.5px] text-emerald-700/80 font-medium leading-relaxed mt-1">
                        An email containing the signature link has been sent to <strong>{signerEmail}</strong>.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-auto pt-6 flex flex-col gap-3">
                  <button
                    onClick={handleCloseDocument}
                    disabled={loading}
                    className="w-full py-4.5 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-2xl shadow-xl shadow-teal-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {loading ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Finalize & Close Trade
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setActiveStep('complete')}
                    className="w-full py-3 text-xs font-black text-slate-400 hover:text-slate-600 transition-colors text-center"
                  >
                    Skip to Completed View
                  </button>
                </div>
              </div>
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
                    : 'The double-party execution workflow has been initialized and signed on your side. The client will complete their signature shortly.'
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
                {!isFx && (
                  <button
                    onClick={handleCloseDocument}
                    className="w-full py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    Force Close & Archive Trade
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
