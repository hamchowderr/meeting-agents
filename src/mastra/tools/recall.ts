import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { Calls } from '../../sales/calls'

/**
 * Tools so any Mastra agent (later: a scheduler, a Client Desk agent) can send the
 * sales call bot to a meeting and run it. Built over the same Calls registry the API uses.
 */
export function recallTools(calls: Calls) {
  const joinSalesCall = createTool({
    id: 'join-sales-call',
    description: 'Send the Otaku notes bot to a Zoom, Google Meet or Teams call and start the live sales co-pilot.',
    inputSchema: z.object({ meetingUrl: z.string().url(), prospect: z.string().optional() }),
    outputSchema: z.object({ callId: z.string(), botId: z.string().nullable(), status: z.string() }),
    execute: async ({ meetingUrl, prospect }) => {
      const s = await calls.start({ meetingUrl, prospect })
      return { callId: s.id, botId: s.botId, status: s.status }
    },
  })
  const leaveCall = createTool({
    id: 'leave-call',
    description: 'Make the bot leave a call.',
    inputSchema: z.object({ callId: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ callId }) => {
      await calls.leave(callId)
      return { ok: true }
    },
  })
  const showMath = createTool({
    id: 'show-math',
    description: "Show or hide the profit math on the bot's camera, which everyone on the call sees.",
    inputSchema: z.object({ callId: z.string(), show: z.boolean() }),
    outputSchema: z.object({ showMath: z.boolean() }),
    execute: async ({ callId, show }) => ({ showMath: !!calls.setShowMath(callId, show)?.showMath }),
  })
  return { joinSalesCall, leaveCall, showMath }
}
