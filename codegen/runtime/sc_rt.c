#include "sc_rt.h"
#include <stdio.h>
#include <string.h>

void (*SC_trace)(const SC_Instance *, const char *, const char *) = 0;

static SC_Instance *g_all;          /* every started instance, for SC_tick */
static struct { SC_Instance *to; SC_Event ev; } g_q[SC_QUEUE_SIZE];
static int g_head, g_count;

#define TRACE(in, what, nm) do { if (SC_trace) SC_trace((in), (what), (nm)); } while (0)

void SC_printTrace(const SC_Instance *in, const char *what, const char *name)
{
    printf("[%s] %-5s %s\n", in->name, what, name);
}

SC_Event SC_makeEvent(int id)
{
    SC_Event e;
    memset(&e, 0, sizeof e);
    e.id = id;
    return e;
}

void SC_init(SC_Instance *in, const SC_Desc *d, void *self, const char *name,
             int *sub, int *hist, int *tmr)
{
    int i;
    in->d = d; in->self = self; in->name = name;
    in->sub = sub; in->hist = hist; in->tmr = tmr;
    in->started = in->terminated = 0;
    for (i = 0; i < d->nstates; i++) sub[i] = hist[i] = -1;
    for (i = 0; i < d->ntimers; i++) { tmr[i] = -1; tmr[d->ntimers + i] = 0; }
    in->next = g_all;
    g_all = in;
}

int SC_isIn(const SC_Instance *in, int s)
{
    const SC_Desc *d = in->d;
    if (!in->started || in->terminated) return 0;
    while (s > 0) {
        int p = d->parent[s];
        if (d->kind[p] == SC_OR && in->sub[p] != s) return 0;
        s = p;
    }
    return 1;
}

/* enter one state: record it in its parent, start its timers, run entry */
static void enterOne(SC_Instance *in, int s)
{
    const SC_Desc *d = in->d;
    int p = d->parent[s], t;
    if (p >= 0 && d->kind[p] == SC_OR) in->sub[p] = s;
    TRACE(in, "enter", d->stateName[s]);
    if (d->entry) d->entry(in->self, s);
    for (t = 0; t < d->ntimers; t++)
        if (d->timerState[t] == s) {
            in->tmr[t] = d->timerMs(in->self, t);
            in->tmr[d->ntimers + t]++;          /* new arming: older timeouts are stale */
        }
}

static void defaultEnter(SC_Instance *in, int s, int viaHistory)
{
    const SC_Desc *d = in->d;
    int r;
    if (d->kind[s] == SC_AND) {
        for (r = d->firstChild[s]; r >= 0; r = d->nextSibling[r]) {
            enterOne(in, r);
            defaultEnter(in, r, 0);
        }
    } else if (d->kind[s] == SC_OR) {
        if (viaHistory && in->hist[s] >= 0) {
            int c = in->hist[s];
            enterOne(in, c);
            defaultEnter(in, c, 0);
        } else if (d->initial) {
            d->initial(in->self, s);
        }
    }
}

void SC_exit(SC_Instance *in, int s)
{
    const SC_Desc *d = in->d;
    int p = d->parent[s], t, r;
    if (d->kind[s] == SC_OR && in->sub[s] >= 0) {
        SC_exit(in, in->sub[s]);
    } else if (d->kind[s] == SC_AND) {
        for (r = d->firstChild[s]; r >= 0; r = d->nextSibling[r]) SC_exit(in, r);
    }
    for (t = 0; t < d->ntimers; t++)
        if (d->timerState[t] == s) { in->tmr[t] = -1; in->tmr[d->ntimers + t]++; }
    if (d->exit) d->exit(in->self, s);
    TRACE(in, "exit", d->stateName[s]);
    if (p >= 0 && d->kind[p] == SC_OR && in->sub[p] == s) {
        in->hist[p] = s;            /* shallow history */
        in->sub[p] = -1;
    }
}

/* enter every state strictly below `from` down to `target`, then target's default */
void SC_enter(SC_Instance *in, int from, int target, int viaHistory)
{
    const SC_Desc *d = in->d;
    int path[64], n = 0, i, s;
    for (s = target; s != from && s >= 0 && n < 64; s = d->parent[s]) path[n++] = s;
    for (i = n - 1; i >= 0; i--) {
        int st = path[i], r;
        enterOne(in, st);
        if (d->kind[st] == SC_AND && i > 0) {          /* sibling regions off the path */
            for (r = d->firstChild[st]; r >= 0; r = d->nextSibling[r])
                if (r != path[i - 1]) { enterOne(in, r); defaultEnter(in, r, 0); }
        }
    }
    defaultEnter(in, target, viaHistory);
}

void SC_terminate(SC_Instance *in)
{
    if (in->started && !in->terminated) SC_exit(in, 0);
    in->terminated = 1;
    TRACE(in, "term", in->d->className);
}

/* innermost-first: children get the event before their ancestors */
static int handle(SC_Instance *in, int s, const SC_Event *ev)
{
    const SC_Desc *d = in->d;
    if (d->kind[s] == SC_OR && in->sub[s] >= 0) {
        if (handle(in, in->sub[s], ev)) return 1;
    } else if (d->kind[s] == SC_AND) {
        int r, done = 0;
        for (r = d->firstChild[s]; r >= 0; r = d->nextSibling[r]) {
            if (!SC_isIn(in, r)) break;      /* a region left the AND state */
            done |= handle(in, r, ev);
        }
        if (done) return 1;
    }
    return d->trans(in->self, s, ev);
}

static void completion(SC_Instance *in)
{
    SC_Event nul = SC_makeEvent(SC_NULL_EVENT);
    int i;
    for (i = 0; i < SC_MAX_NULL_STEPS && !in->terminated && handle(in, 0, &nul); i++)
        ;
}

void SC_start(SC_Instance *in)
{
    in->started = 1;
    defaultEnter(in, 0, 0);
    completion(in);
}

static void dispatch(SC_Instance *in, const SC_Event *ev)
{
    const char *nm = in->d->eventName[ev->id];
    if (!in->started || in->terminated) return;
    if (ev->id == SC_TIMEOUT_EVENT && ev->params.l != in->tmr[in->d->ntimers + ev->timer])
        return;                     /* timer was cancelled or re-armed after it fired */
    TRACE(in, "event", nm ? nm : "?");
    if (!handle(in, 0, ev)) { TRACE(in, "drop", nm ? nm : "?"); return; }
    completion(in);
}

void SC_send(SC_Instance *to, SC_Event ev)
{
    if (g_count == SC_QUEUE_SIZE) { fprintf(stderr, "sc_rt: event queue full\n"); return; }
    g_q[(g_head + g_count) % SC_QUEUE_SIZE].to = to;
    g_q[(g_head + g_count) % SC_QUEUE_SIZE].ev = ev;
    g_count++;
}

int SC_step(void)
{
    SC_Instance *to;
    SC_Event ev;
    if (!g_count) return 0;
    to = g_q[g_head].to;
    ev = g_q[g_head].ev;
    g_head = (g_head + 1) % SC_QUEUE_SIZE;
    g_count--;
    dispatch(to, &ev);
    return 1;
}

int SC_run(void)
{
    int n = 0;
    while (SC_step()) n++;
    return n;
}

void SC_tick(int ms)
{
    SC_Instance *in;
    int t;
    for (in = g_all; in; in = in->next) {
        if (!in->started || in->terminated) continue;
        for (t = 0; t < in->d->ntimers; t++) {
            if (in->tmr[t] < 0) continue;
            in->tmr[t] -= ms;
            if (in->tmr[t] <= 0) {
                SC_Event e = SC_makeEvent(SC_TIMEOUT_EVENT);
                in->tmr[t] = -1;
                e.timer = t;
                e.params.l = in->tmr[in->d->ntimers + t];
                SC_send(in, e);
            }
        }
    }
}
