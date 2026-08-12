DEPLOY = dict(
    a=0.45,            # adoption: share of seats active per day
    phi=0.20,          # peak-hour concentration
    psi=1.0,           # idle KV multiplier (1.0 = evict at turn end)
    tau=0.040,         # TPOT SLO, s/token
    T0=2.0,            # TTFT budget, s
    eta_m=0.85,        # usable HBM fraction
    eta_b=0.70,        # achievable bandwidth fraction
    mfu=0.40,          # prefill model-FLOPs utilisation
    skew=1.15,         # expert routing skew on bandwidth (U4)
    load_factor=0.70,  # don't plan past 70% of capacity (U7)
    band="hi",         # KV accounting: "hi" conservative, "lo" paper-implied
    mtp=False,         # load MTP module for speculative decoding (U3)
    R=2,               # redundancy: N+1 / multi-AZ
)