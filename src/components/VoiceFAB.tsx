'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Mic, Square, Check, AlertCircle } from 'lucide-react'

type FabState = 'idle' | 'recording' | 'processing' | 'success' | 'error'

interface Props {
  onSendMessage: (text: string) => Promise<void>
  onOpenChat: () => void
  language: string
  isRTL: boolean
  isMobile: boolean
  onAliveChange: (alive: boolean) => void
  micSide?: 'left' | 'right'
}

export default function VoiceFAB({ onSendMessage, onOpenChat, language, isRTL, isMobile, onAliveChange, micSide = 'right' }: Props) {
  const [state, setState] = useState<FabState>('idle')
  const [recording, setRecording] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cachedStreamRef = useRef<MediaStream | null>(null)
  const pressStartRef = useRef(0)
  const holdModeRef = useRef(false)
  const activeRef = useRef(false)
  const lastTapRef = useRef(0)
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendMsgRef = useRef(onSendMessage)

  useEffect(() => { sendMsgRef.current = onSendMessage }, [onSendMessage])

  // Notify parent of alive state
  useEffect(() => {
    onAliveChange(state === 'recording')
  }, [state, onAliveChange])

  // Auto-reset success/error states
  useEffect(() => {
    if (state === 'success') {
      const t = setTimeout(() => setState('idle'), 1500)
      return () => clearTimeout(t)
    }
    if (state === 'error') {
      const t = setTimeout(() => setState('idle'), 2000)
      return () => clearTimeout(t)
    }
  }, [state])

  // Release mic on unmount (belt-and-suspenders — stopRecording already does this,
  // but guards against edge cases where the component unmounts mid-recording)
  useEffect(() => {
    return () => {
      cachedStreamRef.current?.getTracks().forEach(t => t.stop())
      cachedStreamRef.current = null
    }
  }, [])

  const lang = language === 'he' ? 'he' : 'en'

  const startRecording = useCallback(async () => {
    if (!cachedStreamRef.current && navigator.mediaDevices?.getUserMedia) {
      try {
        cachedStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setState('error')
        return
      }
    }

    if (typeof MediaRecorder === 'undefined' || !cachedStreamRef.current) {
      setState('error')
      return
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''

    const recorder = new MediaRecorder(cachedStreamRef.current, mimeType ? { mimeType } : {})
    chunksRef.current = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
      if (blob.size < 1000) { setState('idle'); return }

      setState('processing')
      try {
        const fd = new FormData()
        fd.append('audio', blob, `recording.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`)
        fd.append('lang', lang)
        const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `transcribe ${res.status}`)
        if (data.text) {
          await sendMsgRef.current(data.text)
          setState('success')
        } else {
          setState('idle')
        }
      } catch {
        setState('error')
      }
    }

    mediaRecorderRef.current = recorder
    recorder.start(250)
    activeRef.current = true
    setRecording(true)
    setState('recording')
  }, [lang])

  const stopRecording = useCallback(() => {
    activeRef.current = false
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    setRecording(false)
    // Stop all audio tracks so the OS mic indicator (e.g. Apple orange dot) turns off.
    // cachedStreamRef is cleared so the next recording gets a fresh stream via getUserMedia —
    // safe because permission is already granted and re-init takes <50ms.
    cachedStreamRef.current?.getTracks().forEach(t => t.stop())
    cachedStreamRef.current = null
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()

    const now = Date.now()

    // ── Double-tap detected (600ms window) ──────────────────────────────────
    if (now - lastTapRef.current < 600) {
      lastTapRef.current = 0
      // Cancel any pending single-tap recording that hasn't started yet
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current)
        singleTapTimerRef.current = null
      }
      // Use ref (sync) not state (async) — avoids race where recording started
      // but React hasn't re-rendered yet, making `recording` still false
      if (activeRef.current) stopRecording()
      e.stopPropagation()
      setTimeout(() => onOpenChat(), 50)
      return
    }

    lastTapRef.current = now

    // ── Stop recording if already active (use ref for sync accuracy) ─────────
    if (activeRef.current) {
      holdModeRef.current = false
      stopRecording()
      return
    }

    // ── Delay recording start by 400ms — matches the 450ms double-tap window ─
    pressStartRef.current = Date.now() + 400 // offset so hold timer is measured from actual start
    holdModeRef.current = false
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null
      pressStartRef.current = Date.now()
      startRecording()
    }, 400)
  }, [stopRecording, startRecording, onOpenChat])

  const handlePointerUp = useCallback(() => {
    const elapsed = Date.now() - pressStartRef.current
    if (activeRef.current && elapsed >= 400) {
      holdModeRef.current = true
      stopRecording()
    }
  }, [stopRecording])

  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') handlePointerUp()
  }, [handlePointerUp])

  const isProcessing = state === 'processing'
  const isSuccess = state === 'success'
  const isError = state === 'error'

  const bg = recording
    ? 'linear-gradient(135deg,#EF4444,#DC2626)'
    : isSuccess ? 'linear-gradient(135deg,#34D399,#10B981)'
    : isError ? 'linear-gradient(135deg,#F87171,#EF4444)'
    : 'linear-gradient(135deg,#7C3AED,#EC4899)'

  const shadow = recording
    ? '0 6px 30px rgba(239,68,68,0.6)'
    : isSuccess ? '0 6px 30px rgba(52,211,153,0.5)'
    : isError ? '0 6px 30px rgba(248,113,113,0.5)'
    : '0 6px 30px rgba(124,58,237,0.55)'

  const fabClass = recording ? 'fab-recording' : isProcessing ? 'fab-processing' : isSuccess ? 'fab-success' : isError ? 'fab-error' : 'fab-idle'

  const iconNode = isProcessing ? (
    <span style={{
      width: 20, height: 20,
      border: '2.5px solid rgba(255,255,255,0.3)',
      borderTopColor: '#fff',
      borderRadius: '50%',
      display: 'inline-block',
      animation: 'spin 0.7s linear infinite',
    }} />
  ) : isSuccess ? (
    <Check size={22} strokeWidth={3} />
  ) : isError ? (
    <AlertCircle size={22} />
  ) : recording ? (
    <Square size={16} fill="white" />
  ) : (
    <Mic size={22} />
  )

  return (
    <motion.button
      className={fabClass}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onContextMenu={e => e.preventDefault()}
      disabled={isProcessing}
      whileTap={{ scale: 0.88 }}
      animate={{
        background: bg,
        boxShadow: shadow,
        scale: isProcessing ? 0.95 : 1,
      }}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      style={{
        position: 'fixed',
        bottom: isMobile ? 'calc(70px + env(safe-area-inset-bottom, 0px))' : 32,
        // Desktop: tasks panel is 340px wide on the right — FAB must be left of it
        ...(micSide === 'left'
          ? { left: isMobile ? 20 : 32 }
          : { right: isMobile ? 20 : 'calc(340px + 20px)' }),
        width: 56,
        height: 56,
        borderRadius: '50%',
        border: 'none',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: isProcessing ? 'default' : 'pointer',
        zIndex: 9990,
        opacity: isProcessing ? 0.85 : 1,
        WebkitUserSelect: 'none',
        userSelect: 'none',
        touchAction: 'manipulation',
      } as React.CSSProperties}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.15 }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {iconNode}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  )
}
