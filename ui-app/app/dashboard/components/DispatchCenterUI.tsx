'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { Schema, RecentDoc } from '../types';
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
  const [loading, setLoading] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const [senderSignUrl, setSenderSignUrl] = useState<string | null>(null);
  const [counterpartySignUrl, setCounterpartySignUrl] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<'prepare' | 'sign' | 'complete'>('prepare');
  const [copied, setCopied] = useState(false);

  const isFx = activeSchema.id === 'fx_ndf';

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
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
        onShowToast('✍️ Signature request created successfully!');
        setActiveStep('sign');
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
      {/* Header */}
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

      {/* Grid Layout: Split Screen */}
      <div className="flex-1 flex flex-col xl:flex-row gap-6 min-h-0 items-stretch">
        
        {/* Left Panel: Document PDF Preview */}
        <div className="flex-1 min-h-[450px] sm:min-h-[500px] xl:max-h-[calc(100vh-220px)] bg-slate-50 border border-slate-100 rounded-3xl overflow-hidden relative shadow-inner">
          <div className="w-full h-full">
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
        </div>

        {/* Right Panel: Active Configuration Panel */}
        <div className="w-full xl:w-[460px] bg-white border border-slate-100 rounded-3xl shadow-xl flex flex-col p-6 sm:p-8 min-w-0 shrink-0 select-none">
          
          {/* Progress Indicators */}
          <div className="flex items-center gap-3 mb-8 bg-slate-50 p-2 rounded-2xl border border-slate-100">
            <div className={`flex-1 py-2 rounded-xl text-center text-xs font-bold transition-all ${
              activeStep === 'prepare' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400'
            }`}>
              1. Outbox Setup
            </div>
            <div className="h-1 w-4 bg-slate-200 rounded-full" />
            <div className={`flex-1 py-2 rounded-xl text-center text-xs font-bold transition-all ${
              activeStep === 'sign' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400'
            }`}>
              {isFx ? '2. Direct Email' : '2. E-Signature'}
            </div>
            <div className="h-1 w-4 bg-slate-200 rounded-full" />
            <div className={`flex-1 py-2 rounded-xl text-center text-xs font-bold transition-all ${
              activeStep === 'complete' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400'
            }`}>
              3. Executed
            </div>
          </div>

          {/* Step content */}
          {activeStep === 'prepare' && (
            <form onSubmit={handleDispatch} className="flex-1 flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h3 className="text-lg font-black text-slate-800 tracking-tight">Recipient Information</h3>
                <p className="text-xs text-slate-400 font-medium">Enter the counterparty contact details for trade delivery.</p>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="signer-name" className="text-xs font-black text-slate-500 uppercase tracking-widest">Signer / Recipient Name</label>
                  <input
                    type="text"
                    id="signer-name"
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    placeholder="e.g. John Doe"
                    autoComplete="off"
                    className="w-full px-4 py-3.5 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="signer-email" className="text-xs font-black text-slate-500 uppercase tracking-widest">Signer / Recipient Email *</label>
                  <input
                    type="email"
                    id="signer-email"
                    required
                    value={signerEmail}
                    onChange={(e) => setSignerEmail(e.target.value)}
                    placeholder="e.g. client@bank.com"
                    autoComplete="off"
                    className="w-full px-4 py-3.5 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800"
                  />
                </div>

                {isFx && (
                  <div className="flex flex-col gap-2 animate-fade-in">
                    <label htmlFor="custom-msg" className="text-xs font-black text-slate-500 uppercase tracking-widest">Optional Message</label>
                    <textarea
                      id="custom-msg"
                      rows={3}
                      value={customMessage}
                      onChange={(e) => setCustomMessage(e.target.value)}
                      placeholder="Add a custom note to the transaction email..."
                      className="w-full px-4 py-3 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-semibold transition-all text-slate-800 resize-none"
                    />
                  </div>
                )}

                {!isFx && (
                  <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100 flex items-start gap-3 mt-2 animate-fade-in">
                    <span className="text-lg">✍️</span>
                    <div>
                      <p className="text-xs font-bold text-indigo-900 leading-tight">E-Signature Sequence Ready</p>
                      <p className="text-[10.5px] text-indigo-600/80 font-medium leading-relaxed mt-0.5">
                        This IRS/CDS/TRS trade confirmation requires signatures. Clicking dispatch will upload this PDF to DocuSeal and create signing channels for both you and the client.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-auto pt-6 flex flex-col gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-4.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-xl shadow-indigo-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Processing Dispatch...
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      {isFx ? 'Send Confirmation Email' : 'Prepare E-Signature Workflow'}
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {activeStep === 'sign' && !isFx && (
            <div className="flex-1 flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h3 className="text-lg font-black text-slate-800 tracking-tight">Sign Document</h3>
                <p className="text-xs text-slate-400 font-medium">To legally execute this swap, please sign the document first.</p>
              </div>

              <div className="flex flex-col gap-4 flex-1">
                {/* Embedded DocuSeal Iframe for Self-Signing */}
                {senderSignUrl ? (
                  <div className="flex-1 border border-slate-200 rounded-2xl overflow-hidden shadow-inner h-[280px] xl:h-[350px] relative">
                    <iframe
                      src={senderSignUrl}
                      className="w-full h-full border-none"
                      title="Self-Signing Pad"
                    />
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 border border-slate-100 rounded-2xl p-6 text-center">
                    <span className="text-2xl mb-2">🔄</span>
                    <p className="text-xs font-bold text-slate-500">Generating signing credentials...</p>
                  </div>
                )}

                {/* Recipient Details & Manual Copy */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/50 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Counterparty Sign Link</span>
                    <span className="text-[9px] font-extrabold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded uppercase">Emailed</span>
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
                      className="px-3.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-xl text-xs font-bold transition-all border border-indigo-100 cursor-pointer"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-auto pt-6 flex flex-col gap-3">
                <button
                  onClick={handleCloseDocument}
                  disabled={loading}
                  className="w-full py-4 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-2xl shadow-xl shadow-teal-600/10 text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                  className="w-full py-3 text-xs font-black text-slate-500 hover:text-slate-700 transition-colors text-center"
                >
                  Skip to Completed View
                </button>
              </div>
            </div>
          )}

          {activeStep === 'complete' && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6 select-none">
              <div className="w-20 h-20 rounded-[28px] bg-emerald-50 text-emerald-500 flex items-center justify-center text-4xl shadow-xl shadow-emerald-500/10 animate-bounce">
                🎉
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-xl font-black text-slate-800 tracking-tight">Trade Dispatch Complete</h3>
                <p className="text-xs text-slate-400 font-semibold leading-relaxed px-4">
                  {isFx 
                    ? 'The FX NDF Trade Confirmation has been emailed and stored successfully.'
                    : 'The signature request has been dispatched. The trade will be archived automatically once signed.'
                  }
                </p>
              </div>

              <div className="flex flex-col w-full gap-3 mt-4">
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
                    Force Close & Archive
                  </button>
                )}
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  );
}
