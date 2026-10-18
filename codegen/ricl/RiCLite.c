/* RiCLite - see RiCLite.h */
#include "RiCLite.h"
#ifndef RIC_NO_STDIO
#include <stdio.h>
#endif

enum { TM_FREE = 0, TM_ARMED, TM_QUEUED };

static RiCTask mainTask;
static RiCTimeout timeouts[RIC_TIMEOUT_POOL_SIZE];
static RiC_UINT32 timerSeq;          /* counts timer starts */

void (*RiCOXF_errorHook)(int code, const RiCReactive *who) = 0;
void (*RiCOXF_traceHook)(const RiCReactive *who, int kind, const char *what) = 0;
const char *(*RiCOXF_eventNameHook)(RiCEventId id) = 0;

static void report(int code, const RiCReactive *who)
{
    if (RiCOXF_errorHook)
        RiCOXF_errorHook(code, who);
}

/* ---- event pool --------------------------------------------------------- */
static unsigned char *poolBase;
static size_t poolBlock;
static unsigned poolCount;
static void *poolFree;              /* free list threaded through the blocks */

void RiCEventPool_register(void *storage, size_t blockSize, unsigned count)
{
    unsigned i;
    if (blockSize < sizeof(void *))
        blockSize = sizeof(void *);
    poolBase = (unsigned char *)storage;
    poolBlock = blockSize;
    poolCount = count;
    poolFree = 0;
    for (i = count; i > 0; i--) {
        void **blk = (void **)(poolBase + (size_t)(i - 1) * blockSize);
        *blk = poolFree;
        poolFree = blk;
    }
}

void *RiCEventPool_alloc(void)
{
    void **blk;
    RIC_CRITICAL_ENTER();
    blk = (void **)poolFree;
    if (blk)
        poolFree = *blk;
    RIC_CRITICAL_EXIT();
    if (!blk)
        report(RIC_ERR_EVENT_POOL, 0);
    return blk;
}

void RiCEventPool_free(void *block)
{
    unsigned char *p = (unsigned char *)block;
    if (!p || p < poolBase || p >= poolBase + (size_t)poolCount * poolBlock)
        return;
    RIC_CRITICAL_ENTER();
    *(void **)block = poolFree;
    poolFree = block;
    RIC_CRITICAL_EXIT();
}

void RiCEvent_init(RiCEvent *const me, RiCEventId id)
{
    me->lId = id;
    me->flags = RIC_EV_POOLED;
    me->destination = 0;
}

RiCBoolean RiCEvent_isTimeout(const RiCEvent *const me)
{
    return (RiCBoolean)(me->lId == Timeout_id);
}

RiCEventId RiCTimeout_getTimeoutId(const RiCTimeout *const me)
{
    return me->timeoutId;
}

/* ---- queue -------------------------------------------------------------- */
static RiCBoolean enqueue(RiCTask *t, RiCEvent *ev)
{
    RiCBoolean ok = RiCFALSE;
    RIC_CRITICAL_ENTER();
    if (t->count < RIC_QUEUE_SIZE) {
        t->queue[(t->head + t->count) % RIC_QUEUE_SIZE] = ev;
        t->count++;
        ok = RiCTRUE;
    }
    RIC_CRITICAL_EXIT();
    return ok;
}

static RiCEvent *dequeue(RiCTask *t)
{
    RiCEvent *ev = 0;
    RIC_CRITICAL_ENTER();
    if (t->count) {
        ev = t->queue[t->head];
        t->head = (t->head + 1) % RIC_QUEUE_SIZE;
        t->count--;
    }
    RIC_CRITICAL_EXIT();
    return ev;
}

static void release(RiCEvent *ev)
{
    if (ev->lId == Timeout_id) {
        ((RiCTimeout *)ev)->state = TM_FREE;
    } else if (ev->flags & RIC_EV_POOLED) {
        RiCEventPool_free(ev);
    }
}

/* ---- reactive ----------------------------------------------------------- */
RiCBoolean RiCReactive_init(RiCReactive *const me, void *owner, RiCTask *task,
                            const RiCReactive_Vtbl *vtbl)
{
    me->m_vtbl = vtbl;
    me->m_owner = owner;
    me->myTask = task ? task : &mainTask;
    me->current_event = 0;
    me->name = vtbl ? vtbl->className : "";
    me->status = 0;
    return RiCTRUE;
}

void RiCReactive_setName(RiCReactive *const me, const char *name)
{
    me->name = name;
}

void RiCReactive_cleanup(RiCReactive *const me)
{
    unsigned i;
    RIC_CRITICAL_ENTER();
    for (i = 0; i < RIC_TIMEOUT_POOL_SIZE; i++)
        if (timeouts[i].state == TM_ARMED && timeouts[i].ric_event.destination == me)
            timeouts[i].state = TM_FREE;
    RIC_CRITICAL_EXIT();
    me->status = RIC_R_TERMINATED;
}

void RiCReactive_terminate(RiCReactive *const me)
{
    RiCReactive_cleanup(me);
}

/* run triggerless transitions until the configuration is stable */
static void runNull(RiCReactive *const me)
{
    int n = 0;
    me->current_event = 0;
    while (!(me->status & RIC_R_TERMINATED) && n < RIC_MAX_NULL_STEPS &&
           me->m_vtbl->dispEventFunc(me->m_owner, Null_id) == eventConsumed)
        n++;
}

RiCBoolean RiCReactive_startBehavior(RiCReactive *const me)
{
    if (me->status & (RIC_R_STARTED | RIC_R_TERMINATED))
        return RiCFALSE;
    me->status |= RIC_R_STARTED;
    me->m_vtbl->rootState_entDefFunc(me->m_owner);
    runNull(me);
    return RiCTRUE;
}

RiCBoolean RiCReactive_gen(RiCReactive *const me, RiCEvent *event, RiCBoolean fromISR)
{
    if (!event)
        return RiCFALSE;                       /* pool exhausted, reported */
    if (fromISR)
        event->flags = (unsigned char)(event->flags & ~RIC_EV_POOLED);
    event->destination = me;
    if (!enqueue(me->myTask, event)) {
        report(RIC_ERR_QUEUE_FULL, me);
        release(event);
        return RiCFALSE;
    }
    return RiCTRUE;
}

/* ---- timers ------------------------------------------------------------- */
void RiCTask_schedTm(RiCTask *const me, RiC_UINT32 deltaTime, RiCEventId timeoutId,
                     RiCReactive *const reactive, const char *const msg)
{
    unsigned i;
    RiCTimeout *tm = 0;
    RIC_CRITICAL_ENTER();
    for (i = 0; i < RIC_TIMEOUT_POOL_SIZE; i++)
        if (timeouts[i].state == TM_FREE) {
            tm = &timeouts[i];
            tm->state = TM_ARMED;
            break;
        }
    RIC_CRITICAL_EXIT();
    if (!tm) {
        report(RIC_ERR_TIMEOUT_POOL, reactive);
        return;
    }
    tm->ric_event.lId = Timeout_id;
    tm->ric_event.flags = 0;
    tm->ric_event.destination = reactive;
    tm->timeoutId = timeoutId;
    tm->msg = msg;
    tm->dueTime = me->now + deltaTime;
    tm->seq = ++timerSeq;
    if (deltaTime == 0) {
        tm->state = TM_QUEUED;
        if (!enqueue(me, &tm->ric_event)) {
            report(RIC_ERR_QUEUE_FULL, reactive);
            tm->state = TM_FREE;
        }
    }
}

void RiCTask_unschedTm(RiCTask *const me, RiCEventId timeoutId, const RiCReactive *const reactive)
{
    unsigned i;
    (void)me;
    RIC_CRITICAL_ENTER();
    for (i = 0; i < RIC_TIMEOUT_POOL_SIZE; i++) {
        RiCTimeout *tm = &timeouts[i];
        if (tm->ric_event.destination != reactive || tm->timeoutId != timeoutId)
            continue;
        if (tm->state == TM_ARMED)
            tm->state = TM_FREE;
        else if (tm->state == TM_QUEUED)
            tm->ric_event.flags |= RIC_EV_CANCELLED;   /* freed when dequeued */
    }
    RIC_CRITICAL_EXIT();
}

void RiCOXF_tick(RiC_UINT32 ms)
{
    RiCTask *t = &mainTask;
    t->now += ms;
    for (;;) {                              /* expire in due-time order */
        unsigned i;
        RiCTimeout *best = 0;
        RIC_CRITICAL_ENTER();
        for (i = 0; i < RIC_TIMEOUT_POOL_SIZE; i++) {
            RiCTimeout *tm = &timeouts[i];
            if (tm->state == TM_ARMED && (long)(tm->dueTime - t->now) <= 0 &&
                (!best || (long)(tm->dueTime - best->dueTime) < 0 ||
                 (tm->dueTime == best->dueTime && (long)(tm->seq - best->seq) < 0)))
                best = tm;
        }
        if (best)
            best->state = TM_QUEUED;
        RIC_CRITICAL_EXIT();
        if (!best)
            break;
        if (!enqueue(t, &best->ric_event)) {
            report(RIC_ERR_QUEUE_FULL, best->ric_event.destination);
            best->state = TM_FREE;
        }
    }
}

/* ---- main loop ---------------------------------------------------------- */
void RiCOXF_Init(void)
{
    unsigned i;
    mainTask.head = mainTask.count = 0;
    mainTask.now = 0;
    for (i = 0; i < RIC_TIMEOUT_POOL_SIZE; i++)
        timeouts[i].state = TM_FREE;
}

RiCTask *RiCOXF_mainTask(void)
{
    return &mainTask;
}

RiC_UINT32 RiCOXF_now(void)
{
    return mainTask.now;
}

unsigned RiCOXF_pendingEvents(void)
{
    return mainTask.count;
}

static const char *evName(RiCEventId id)
{
    if (id == Timeout_id)
        return "tm";
    return RiCOXF_eventNameHook ? RiCOXF_eventNameHook(id) : "event";
}

RiCBoolean RiCOXF_step(void)
{
    RiCEvent *ev = dequeue(&mainTask);
    RiCReactive *r;
    if (!ev)
        return RiCFALSE;
    r = ev->destination;
    if ((ev->flags & RIC_EV_CANCELLED) || !r || (r->status & RIC_R_TERMINATED) ||
        !(r->status & RIC_R_STARTED)) {
        release(ev);
        return RiCTRUE;
    }
    r->current_event = ev;
    RIC_TRACE(r, RIC_TR_EVENT, ev->lId == Timeout_id ? ((RiCTimeout *)ev)->msg : evName(ev->lId));
    if (r->m_vtbl->dispEventFunc(r->m_owner, ev->lId) == eventConsumed)
        runNull(r);
    else
        RIC_TRACE(r, RIC_TR_DROP, evName(ev->lId));
    r->current_event = 0;
    release(ev);
    return RiCTRUE;
}

RiCTakeEventStatus RiCReactive_takeTrigger(RiCReactive *const me, RiCEvent *trigger)
{
    RiCEvent *saved;
    RiCTakeEventStatus st;
    if (!(me->status & RIC_R_STARTED) || (me->status & RIC_R_TERMINATED))
        return eventNotConsumed;
    saved = me->current_event;
    me->current_event = trigger;
    RIC_TRACE(me, RIC_TR_EVENT, evName(trigger->lId));
    st = me->m_vtbl->dispEventFunc(me->m_owner, trigger->lId);
    if (st == eventConsumed)
        runNull(me);
    else
        RIC_TRACE(me, RIC_TR_DROP, evName(trigger->lId));
    me->current_event = saved;
    return st;
}

unsigned RiCOXF_processEvents(void)
{
    unsigned n = 0;
    while (RiCOXF_step())
        n++;
    return n;
}

#ifndef RIC_NO_STDIO
void RiCOXF_printTrace(const RiCReactive *who, int kind, const char *what)
{
    static const char *const k[] = { "enter", "exit", "event", "drop", "trans" };
    printf("[%6lu] %-10s %-5s %s\n", (unsigned long)mainTask.now, who ? who->name : "",
           k[kind], what ? what : "");
}
#endif
