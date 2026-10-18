/* Drives the generated Oven statechart through a scripted scenario. */
#include <stdio.h>
#include "Oven.h"

static Oven oven;

static void send(SC_Event e) { SC_send(&oven.sc, e); SC_run(); }

int main(void)
{
    int i;
    SC_trace = SC_printTrace;
    Oven_Init(&oven, "oven");
    Oven_startBehavior(&oven);

    puts("-- start 3s");
    send(evStart(3));
    printf("IN heating=%d lampOn=%d\n", Oven_heating_IN(&oven), Oven_lampOn_IN(&oven));

    puts("-- 500ms passes: lamp region blinks, heat region untouched");
    SC_tick(500); SC_run();
    printf("IN heating=%d lampBlink=%d\n", Oven_heating_IN(&oven), Oven_lampBlink_IN(&oven));

    puts("-- pause, tick is handled by the static reaction on 'working'");
    send(evStop());
    send(evTick());

    puts("-- open the door while paused, close it: history brings back 'paused'");
    send(evDoor());
    send(evDoor());
    printf("IN paused=%d (history) lampOn=%d (default)\n", Oven_paused_IN(&oven), Oven_lampOn_IN(&oven));

    puts("-- resume and count down through the condition connector");
    send(evStart(0));
    for (i = 0; i < 3; i++) send(evTick());
    printf("IN done=%d remaining=%d\n", Oven_done_IN(&oven), oven.remaining);

    puts("-- timeouts re-enter beeping until beeps >= 3");
    for (i = 0; i < 3; i++) { SC_tick(1000); SC_run(); }
    printf("IN quiet=%d beeps=%d\n", Oven_quiet_IN(&oven), oven.beeps);

    puts("-- door: done -> idle -> doorOpen -> idle");
    send(evDoor());
    send(evDoor());
    printf("doorOpen attr while open: %d\n", oven.doorOpen);
    send(evDoor());
    printf("IN idle=%d\n", Oven_idle_IN(&oven));
    return 0;
}
