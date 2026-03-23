'use client'

import { motion, AnimatePresence } from 'motion/react'
import { CalendarDays, CheckSquare, MessageCircle, AlertCircle } from 'lucide-react'
import type { ToastItem } from '@/hooks/useChatEngine'

interface Props {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
  onTap: () => void
  isRTL: boolean
  isMobile: boolean
}

const iconMap = {
  event_created: <CalendarDays size={16} />,
  task_created: <CheckSquare size={16} />,
  message: <MessageCircle size={16} />,
  error: <AlertCircle size={16} />,
}

const colorMap = {
  event_created: 'var(--green)',
  task_created: 'var(--blue)',
  message: 'var(--indigo)',
  error: 'var(--red)',
}

export default function ToastContainer({ toasts, onDismiss, onTap, isRTL, isMobile }: Props) {
  if (toasts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: isMobile ? 'calc(136px + env(safe-area-inset-bottom, 0px))' : 100,
        [isRTL ? 'left' : 'right']: isMobile ? 16 : 32,
        zIndex: 9989,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        maxWidth: isMobile ? 'calc(100vw - 32px)' : 340,
        pointerEvents: 'auto',
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast, i) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: isRTL ? -40 : 40, scale: 0.92 }}
            animate={{ opacity: i > 1 ? 0.6 : 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: isRTL ? -40 : 40, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={() => { onDismiss(toast.id); onTap() }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              borderRadius: 14,
              background: 'rgba(13,13,24,0.92)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              cursor: 'pointer',
              direction: isRTL ? 'rtl' : 'ltr',
            }}
          >
            <div style={{ color: colorMap[toast.type], flexShrink: 0 }}>
              {iconMap[toast.type]}
            </div>
            <div style={{
              fontSize: 13, lineHeight: 1.4, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            } as React.CSSProperties}>
              {toast.text}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
