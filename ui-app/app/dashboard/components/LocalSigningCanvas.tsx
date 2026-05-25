'use client';

import React from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Set worker for react-pdf
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version || '4.4.0'}/build/pdf.worker.min.mjs`;
}

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

interface LocalSigningCanvasProps {
  pdfUrl: string;
  selectedTool: 'text' | 'signature' | 'date' | null;
  setSelectedTool: (tool: 'text' | 'signature' | 'date' | null) => void;
  placedFields: PlacedField[];
  setPlacedFields: React.Dispatch<React.SetStateAction<PlacedField[]>>;
  selectedFieldId: string | null;
  setSelectedFieldId: (id: string | null) => void;
  activeDragId: string | null;
  activeResizeId: string | null;
  onDragMove: (e: React.MouseEvent) => void;
  endDrag: () => void;
  startDrag: (e: React.MouseEvent, id: string) => void;
  startResize: (e: React.MouseEvent, id: string, handle: 'tl' | 'tr' | 'bl' | 'br') => void;
  addFieldAtPosition: (type: 'signature' | 'text' | 'date', px: number, py: number) => void;
  signatureImage: string | null;
  setShowSigModal: (show: boolean) => void;
  setPendingSigCoords: (coords: { x: number, y: number } | null) => void;
}

export default function LocalSigningCanvas({
  pdfUrl,
  selectedTool,
  setSelectedTool,
  placedFields,
  setPlacedFields,
  selectedFieldId,
  setSelectedFieldId,
  activeDragId,
  activeResizeId,
  onDragMove,
  endDrag,
  startDrag,
  startResize,
  addFieldAtPosition,
  signatureImage,
  setShowSigModal,
  setPendingSigCoords,
}: LocalSigningCanvasProps) {
  return (
    <div 
      onMouseMove={onDragMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      className="flex-1 w-full h-[650px] sm:h-[750px] lg:h-[800px] bg-slate-100 border border-slate-200 rounded-3xl relative shadow-inner overflow-auto select-none animate-fade-in flex flex-col items-center p-8 pt-20 custom-scrollbar"
    >
      {/* Floating Acrobat Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-md px-5 py-2.5 rounded-full border border-slate-800 text-white flex items-center gap-5 shadow-xl z-20 select-none animate-fade-in">
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none border-r border-slate-700 pr-4">
          ✍️ E-Sign Tools
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedTool(selectedTool === 'text' ? null : 'text');
              setSelectedFieldId(null);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
              selectedTool === 'text' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 text-slate-300'
            }`}
          >
            <span>A</span> Insert Text
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedTool(selectedTool === 'signature' ? null : 'signature');
              setSelectedFieldId(null);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
              selectedTool === 'signature' ? 'bg-amber-500 text-white shadow-md' : 'hover:bg-slate-800 text-slate-300'
            }`}
          >
            <span>✍️</span> Stamp Signature
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedTool(selectedTool === 'date' ? null : 'date');
              setSelectedFieldId(null);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
              selectedTool === 'date' ? 'bg-sky-500 text-white shadow-md' : 'hover:bg-slate-800 text-slate-300'
            }`}
          >
            <span>📅</span> Today's Date
          </button>
        </div>
        {selectedTool && (
          <span className="text-[9px] font-extrabold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 animate-pulse uppercase tracking-wider">
            Click document to place
          </span>
        )}
      </div>

      {/* Centered Document Wrapper matching standard page boundaries */}
      <div 
        style={{
          width: '600px', // Exact rendered PDF width
          position: 'relative'
        }}
        className="shadow-[0_20px_50px_rgba(0,0,0,0.15)] rounded-sm overflow-hidden bg-white shrink-0"
      >
        <Document
          file={pdfUrl}
          loading={
            <div className="w-[600px] h-[800px] bg-white animate-pulse flex flex-col items-center justify-center gap-3">
              <div className="w-8 h-8 border-4 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Loading PDF Page...</p>
            </div>
          }
        >
          <Page
            pageNumber={1}
            width={600}
            renderTextLayer={false}
            renderAnnotationLayer={false}
          />
        </Document>

        {/* Click-to-Place Pointer Event Overlay */}
        <div 
          onClick={(e) => {
            if (!selectedTool) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * 100;
            const py = ((e.clientY - rect.top) / rect.height) * 100;
            addFieldAtPosition(selectedTool, px, py);
          }}
          style={{
            cursor: selectedTool ? 'crosshair' : 'default'
          }}
          className="absolute inset-0 z-10"
        />

        {/* Dynamic Drag-and-Drop / Resizable Fields inside the exact container */}
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
                width: `${field.w}%`,
                height: `${field.h}%`,
                cursor: activeDragId === field.id ? 'grabbing' : 'grab',
                border: isSelected 
                  ? `1px solid ${isSig ? '#d97706' : '#2563eb'}` 
                  : '1px solid transparent',
                padding: '2px',
                borderRadius: '4px',
                backgroundColor: isSelected 
                  ? (isSig ? 'rgba(254, 243, 199, 0.45)' : 'rgba(239, 246, 255, 0.45)')
                  : 'transparent',
                backdropFilter: 'none',
                zIndex: isSelected ? 40 : 30,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                transition: activeDragId === field.id || activeResizeId === field.id ? 'none' : 'box-shadow 0.15s, border-color 0.15s'
              }}
              className={`select-none group ${isSelected ? 'shadow-sm ring-1 ring-blue-500/10' : ''}`}
            >
              {/* Floating Micro-Controls Toolbar */}
              {isSelected && (
                <div 
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-900 text-white rounded-lg shadow-lg px-2 py-0.5 flex items-center gap-1.5 z-50 text-[9px] font-black border border-slate-700/50 select-none animate-fade-in shrink-0"
                >
                  {!isSig && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setPlacedFields(prev => prev.map(f => f.id === field.id ? { ...f, fontSize: Math.max(8, (f.fontSize || 11) - 1) } : f));
                        }}
                        className="px-1.5 py-0.5 hover:bg-slate-800 rounded text-slate-300 font-inter cursor-pointer"
                        title="Decrease Font"
                      >
                        A-
                      </button>
                      <span className="text-slate-600">|</span>
                      <button
                        type="button"
                        onClick={() => {
                          setPlacedFields(prev => prev.map(f => f.id === field.id ? { ...f, fontSize: Math.min(24, (f.fontSize || 11) + 1) } : f));
                        }}
                        className="px-1.5 py-0.5 hover:bg-slate-800 rounded text-slate-300 font-inter cursor-pointer"
                        title="Increase Font"
                      >
                        A+
                      </button>
                      <span className="text-slate-600">|</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPlacedFields(prev => prev.filter(f => f.id !== field.id));
                      if (selectedFieldId === field.id) setSelectedFieldId(null);
                    }}
                    className="px-1.5 py-0.5 hover:bg-rose-950 text-rose-400 rounded font-inter cursor-pointer flex items-center gap-0.5"
                    title="Delete Stamp"
                  >
                    🗑️ Delete
                  </button>
                </div>
              )}

              {/* Corner Resize Handles */}
              {isSelected && (
                <>
                  <div 
                    onMouseDown={(e) => startResize(e, field.id, 'tl')}
                    className="w-2 h-2 bg-white border border-blue-600 rounded-full absolute -top-1 -left-1 cursor-nwse-resize z-50 hover:scale-125 transition-transform shadow" 
                  />
                  <div 
                    onMouseDown={(e) => startResize(e, field.id, 'tr')}
                    className="w-2 h-2 bg-white border border-blue-600 rounded-full absolute -top-1 -right-1 cursor-nesw-resize z-50 hover:scale-125 transition-transform shadow" 
                  />
                  <div 
                    onMouseDown={(e) => startResize(e, field.id, 'bl')}
                    className="w-2 h-2 bg-white border border-blue-600 rounded-full absolute -bottom-1 -left-1 cursor-nesw-resize z-50 hover:scale-125 transition-transform shadow" 
                  />
                  <div 
                    onMouseDown={(e) => startResize(e, field.id, 'br')}
                    className="w-2 h-2 bg-white border border-blue-600 rounded-full absolute -bottom-1 -right-1 cursor-nwse-resize z-50 hover:scale-125 transition-transform shadow" 
                  />
                </>
              )}

              {isSig ? (
                field.value ? (
                  <img 
                    src={field.value} 
                    alt="Signature Stamp" 
                    className="max-w-full max-h-full object-contain pointer-events-none mx-auto" 
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center py-1 text-slate-400 gap-1 w-full h-full border border-dashed border-amber-400/40 rounded bg-amber-500/5">
                    <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                    <span className="text-[7.5px] font-black text-amber-600/80 uppercase tracking-wide leading-none">Setup Signature</span>
                  </div>
                )
              ) : (
                <div className="flex flex-col justify-center h-full">
                  <span 
                    style={{ 
                      fontSize: `${field.fontSize || 11}px`,
                      fontFamily: 'Helvetica, Arial, sans-serif',
                      color: '#111827'
                    }}
                    className="font-bold break-words leading-tight"
                  >
                    {field.value || <em className="text-slate-300 font-normal">Type here...</em>}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
