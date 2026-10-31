// Command input for the WebAssembly build of the engine (replaces stdin, see uci.c).
//
// JavaScript calls wasm_send() with one UCI line at a time. The lines are queued here and
// read by the UCI loop through wasm_fgets() / wasm_input_waiting().
//
// Threaded build (-pthread, PROXY_TO_PTHREAD): the UCI loop runs on its own thread and blocks
// in wasm_fgets() until a line arrives; "stop" reaches a running search through
// wasm_input_waiting(), exactly as stdin does natively.
//
// Single-threaded build: nothing can block. wasm_fgets() returns NULL when the queue is empty,
// and JavaScript runs the loop over the queued lines with wasm_pump() after each wasm_send().
// A running search cannot see "stop"; the app stops it by terminating the worker.

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <pthread.h>
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t arrived = PTHREAD_COND_INITIALIZER;
#define LOCK() pthread_mutex_lock(&lock)
#define UNLOCK() pthread_mutex_unlock(&lock)
#else
#define LOCK()
#define UNLOCK()
#endif

#define QUEUE_MAX 256
#define LINE_MAX_LEN 65536

static char* queue[QUEUE_MAX];
static int head = 0, count = 0;

EMSCRIPTEN_KEEPALIVE void wasm_send(const char* line) {
    size_t n = strlen(line);
    if (n >= LINE_MAX_LEN) n = LINE_MAX_LEN - 1;
    char* copy = (char*)malloc(n + 2);
    memcpy(copy, line, n);
    copy[n] = '\n';
    copy[n + 1] = '\0';
    LOCK();
    if (count < QUEUE_MAX) {
        queue[(head + count) % QUEUE_MAX] = copy;
        count++;
        copy = NULL;
    }
#ifdef __EMSCRIPTEN_PTHREADS__
    pthread_cond_signal(&arrived);
#endif
    UNLOCK();
    free(copy);  // only when the queue was full
}

int wasm_input_waiting(void) {
    LOCK();
    int n = count;
    UNLOCK();
    return n > 0;
}

char* wasm_fgets(char* buf, int size) {
    LOCK();
#ifdef __EMSCRIPTEN_PTHREADS__
    while (count == 0) pthread_cond_wait(&arrived, &lock);
#else
    if (count == 0) {
        UNLOCK();
        return NULL;
    }
#endif
    char* line = queue[head];
    head = (head + 1) % QUEUE_MAX;
    count--;
    UNLOCK();
    strncpy(buf, line, (size_t)size - 1);
    buf[size - 1] = '\0';
    free(line);
    return buf;
}
