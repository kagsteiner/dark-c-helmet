#ifndef UTIL_H
#define UTIL_H

#include <string.h>
#include <time.h>

static inline long long now_ms(void) {
    struct timespec ts;
    timespec_get(&ts, TIME_UTC);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

// Portable re-entrant tokenizer (strtok_r is POSIX, strtok_s is MSVC).
static inline char* strtok_r_portable(char* str, const char* delim, char** save) {
    char* s = str ? str : *save;
    if (!s) return NULL;
    s += strspn(s, delim);
    if (!*s) {
        *save = s;
        return NULL;
    }
    char* end = s + strcspn(s, delim);
    if (*end) *end++ = '\0';
    *save = end;
    return s;
}

#endif
