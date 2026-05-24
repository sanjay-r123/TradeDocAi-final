'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { RecentDoc } from '../types';

interface ExtractionEfficiencyChartProps {
  documents: RecentDoc[];
}

export default function ExtractionEfficiencyChart({ documents = [] }: ExtractionEfficiencyChartProps) {
  // Compute counts matching application core logic
  const draftsCount = documents.filter(doc => doc.is_draft || doc.status === 'draft').length;
  const actionRequiredCount = documents.filter(doc => 
    doc.status === 'compiled' || 
    doc.status === 'dispatched' || 
    doc.status === 'signed' || 
    (!doc.status && !doc.is_draft)
  ).length;
  const closedCount = documents.filter(doc => doc.status === 'closed').length;

  const total = documents.length;

  // Percentage for composition bar
  const draftsPercent = total > 0 ? (draftsCount / total) * 100 : 0;
  const actionRequiredPercent = total > 0 ? (actionRequiredCount / total) * 100 : 0;
  const closedPercent = total > 0 ? (closedCount / total) * 100 : 0;

  return (
    <div className="flex flex-col gap-4 sm:gap-5 w-full select-none">
      <div className="flex justify-between items-center">
        <h2 className="text-lg sm:text-xl font-black text-slate-800 font-inter tracking-tight">
          Document Lifecycle Analytics
        </h2>
        <div className="bg-slate-50 text-slate-400 text-[9px] sm:text-[10px] font-bold px-3 py-1 rounded-full border border-slate-100 uppercase tracking-widest">
          {total} TOTAL
        </div>
      </div>

      <div className="flex flex-col w-full bg-white rounded-2xl p-5 sm:p-6 shadow-md border border-slate-100 min-h-[220px] sm:min-h-[280px] gap-6 justify-between">
        
        {/* Status Counts Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          
          {/* Card 1: Drafts */}
          <div className="bg-amber-50/40 border border-amber-100 rounded-2xl p-4 flex flex-col justify-between hover:shadow-md hover:border-amber-200 transition-all group">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">
                Drafts
              </span>
              <span className="text-lg group-hover:scale-110 transition-transform">📝</span>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-black text-amber-600 tracking-tight font-inter">
                {draftsCount}
              </span>
              <span className="text-[10px] text-amber-500/80 font-bold uppercase tracking-wider">
                Active
              </span>
            </div>
            <p className="text-[10.5px] text-slate-400 font-medium leading-tight mt-1.5 border-t border-amber-100/50 pt-1.5">
              AI Extractions & manual work-in-progress drafts.
            </p>
          </div>

          {/* Card 2: Action Required */}
          <div className="bg-indigo-50/40 border border-indigo-100 rounded-2xl p-4 flex flex-col justify-between hover:shadow-md hover:border-indigo-200 transition-all group">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">
                Action Required
              </span>
              <span className="text-lg group-hover:scale-110 transition-transform">⚡</span>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-black text-indigo-600 tracking-tight font-inter">
                {actionRequiredCount}
              </span>
              <span className="text-[10px] text-indigo-500/80 font-bold uppercase tracking-wider animate-pulse">
                Pending
              </span>
            </div>
            <p className="text-[10.5px] text-slate-400 font-medium leading-tight mt-1.5 border-t border-indigo-100/50 pt-1.5">
              Ready for templates setup, self-sign, or client e-signatures.
            </p>
          </div>

          {/* Card 3: Closed */}
          <div className="bg-emerald-50/40 border border-emerald-100 rounded-2xl p-4 flex flex-col justify-between hover:shadow-md hover:border-emerald-200 transition-all group">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                Closed / Archived
              </span>
              <span className="text-lg group-hover:scale-110 transition-transform">🔒</span>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-black text-emerald-600 tracking-tight font-inter">
                {closedCount}
              </span>
              <span className="text-[10px] text-emerald-500/80 font-bold uppercase tracking-wider">
                Executed
              </span>
            </div>
            <p className="text-[10.5px] text-slate-400 font-medium leading-tight mt-1.5 border-t border-emerald-100/50 pt-1.5">
              Fully executed legal trade confirmations filed in vault.
            </p>
          </div>

        </div>

        {/* Visual composition bar */}
        {total > 0 ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-wider">
              <span>Workspace Composition</span>
              <span className="text-slate-500">{Math.round(closedPercent)}% Executed</span>
            </div>
            
            {/* Multi-segmented ratio bar */}
            <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden flex shadow-inner">
              {draftsCount > 0 && (
                <motion.div
                  className="bg-amber-400 h-full"
                  style={{ width: `${draftsPercent}%` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${draftsPercent}%` }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                  title={`Drafts: ${draftsCount}`}
                />
              )}
              {actionRequiredCount > 0 && (
                <motion.div
                  className="bg-indigo-500 h-full"
                  style={{ width: `${actionRequiredPercent}%` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${actionRequiredPercent}%` }}
                  transition={{ duration: 1, ease: 'easeOut', delay: 0.1 }}
                  title={`Action Required: ${actionRequiredCount}`}
                />
              )}
              {closedCount > 0 && (
                <motion.div
                  className="bg-emerald-500 h-full"
                  style={{ width: `${closedPercent}%` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${closedPercent}%` }}
                  transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
                  title={`Closed / Archived: ${closedCount}`}
                />
              )}
            </div>

            {/* Legends */}
            <div className="flex flex-wrap gap-4 mt-1 text-[10.5px] font-bold text-slate-500 uppercase tracking-widest justify-center">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 bg-amber-400 rounded-full" />
                <span>Drafts ({draftsCount})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 bg-indigo-500 rounded-full" />
                <span>Action Required ({actionRequiredCount})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 bg-emerald-500 rounded-full" />
                <span>Closed ({closedCount})</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center bg-slate-50 rounded-2xl border border-slate-100">
            <span className="text-xl mb-1.5">📊</span>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">No transactional analytics available</p>
          </div>
        )}

      </div>
    </div>
  );
}
