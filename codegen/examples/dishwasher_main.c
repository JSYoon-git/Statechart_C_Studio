/* Runs code generated from Rhapsody's C "Dishwasher" sample model.
 * Wires the objects the way the sample's component does, starts a cycle and
 * advances simulated time until the cycle completes. */
#include <stdio.h>
#include "Dishwasher.h"
#include "Jet.h"
#include "Heater.h"
#include "Tank.h"

static Dishwasher dw;
static Jet jet;
static Heater heater;
static Tank tank;

int main(int argc, char **argv)
{
    int ms;
    if (argc > 1) SC_trace = SC_printTrace;      /* any argument: full state trace */

    Dishwasher_Init(&dw, "dishwasher");
    Jet_Init(&jet, "jet");
    Heater_Init(&heater, "heater");
    Tank_Init(&tank, "tank");
    dw.itsJet = &jet;
    dw.itsHeater = &heater;
    dw.itsTank = &tank;
    tank.itsDishwasher = &dw;

    Dishwasher_startBehavior(&dw);
    Jet_startBehavior(&jet);
    Heater_startBehavior(&heater);
    Tank_startBehavior(&tank);
    SC_run();

    puts("== evStart");
    SC_send(&dw.sc, evStart());
    SC_run();

    for (ms = 0; ms < 120000 && !Dishwasher_off_IN(&dw); ms += 100) {
        SC_tick(100);
        SC_run();
    }
    printf("== cycle finished after %d ms simulated; off=%d cycles=%d tank empty=%d jet idle=%d\n",
           ms, Dishwasher_off_IN(&dw), dw.cycles, Tank_empty_IN(&tank), Jet_idle_IN(&jet));

    puts("== door open / close (history connector inside 'operation')");
    SC_send(&dw.sc, evOpen());  SC_run();
    printf("doorOpened=%d\n", Dishwasher_doorOpened_IN(&dw));
    SC_send(&dw.sc, evClose()); SC_run();
    printf("doorClosed=%d off=%d\n", Dishwasher_doorClosed_IN(&dw), Dishwasher_off_IN(&dw));
    return 0;
}
