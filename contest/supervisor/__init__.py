"""Process and container lifecycle for the contest runner.

Hosted contest runs schedule from ``contest/driver.py``. This package is the
decision core those hooks call. ``cli.py`` is the worker-directory layout and
must not dispatch while the driver holds the scheduler lock.
"""
