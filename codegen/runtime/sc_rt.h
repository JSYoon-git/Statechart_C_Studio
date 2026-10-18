/* sc_rt - tiny run-to-completion statechart runtime used by sc2c output.
 *
 * Generated classes describe their state tree with static tables (SC_Desc)
 * and supply four callbacks: entry/exit actions, default transitions and the
 * transition table of one state. Everything else - hierarchy walking, AND
 * regions, history, timers, the event queue - lives here.
 */
#ifndef SC_RT_H
#define SC_RT_H

#include <stddef.h>

#ifndef SC_MAX_PARAMS
#define SC_MAX_PARAMS 64        /* bytes of event payload */
#endif
#ifndef SC_QUEUE_SIZE
#define SC_QUEUE_SIZE 256
#endif
#ifndef SC_MAX_NULL_STEPS
#define SC_MAX_NULL_STEPS 100   /* guard against endless triggerless loops */
#endif

enum { SC_NULL_EVENT = 0, SC_TIMEOUT_EVENT = 1, SC_FIRST_USER_EVENT = 2 };
enum { SC_LEAF = 0, SC_OR = 1, SC_AND = 2 };

typedef struct SC_Event {
    int id;
    int timer;                                  /* SC_TIMEOUT_EVENT only */
    union { double d; void *p; long long l; unsigned char b[SC_MAX_PARAMS]; } params;
} SC_Event;

typedef struct SC_Desc {
    const char *className;
    int nstates, ntimers;
    const int *parent;              /* parent[0] == -1 (root)            */
    const unsigned char *kind;      /* SC_LEAF / SC_OR / SC_AND           */
    const int *firstChild, *nextSibling;
    const char *const *stateName;
    const char *const *eventName;   /* indexed by event id               */
    const int *timerState;          /* state that owns each timer        */
    void (*entry)(void *me, int s);
    void (*exit)(void *me, int s);
    void (*initial)(void *me, int s);                 /* default transition */
    int  (*trans)(void *me, int s, const SC_Event *ev);
    int  (*timerMs)(void *me, int t);
} SC_Desc;

typedef struct SC_Instance {
    const SC_Desc *d;
    void *self;
    const char *name;
    int *sub, *hist, *tmr;          /* per-state storage; tmr holds 2*ntimers:
                                       remaining ms, then arming sequence      */
    int started, terminated;
    struct SC_Instance *next;
} SC_Instance;

/* lifecycle */
void SC_init(SC_Instance *in, const SC_Desc *d, void *self, const char *name,
             int *sub, int *hist, int *tmr);
void SC_start(SC_Instance *in);

/* scheduling: events are queued and processed one at a time (run-to-completion) */
void SC_send(SC_Instance *to, SC_Event ev);
int  SC_step(void);                 /* process one queued event; 0 if idle  */
int  SC_run(void);                  /* drain the queue; returns events done */
void SC_tick(int ms);               /* advance timers of every instance     */
SC_Event SC_makeEvent(int id);

/* used by generated transition code */
void SC_exit(SC_Instance *in, int s);                        /* exit s and below */
void SC_enter(SC_Instance *in, int from, int target, int viaHistory);
void SC_terminate(SC_Instance *in);
int  SC_isIn(const SC_Instance *in, int s);

/* optional trace hook: what is "enter", "exit", "event", "drop" */
extern void (*SC_trace)(const SC_Instance *in, const char *what, const char *name);
void SC_printTrace(const SC_Instance *in, const char *what, const char *name);

#endif
