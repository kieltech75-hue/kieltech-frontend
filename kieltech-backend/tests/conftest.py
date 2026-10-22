import os


test_database_url = (os.getenv('KIELTECH_TEST_DATABASE_URL') or '').strip()
if not test_database_url:
    raise RuntimeError(
        'KIELTECH_TEST_DATABASE_URL must point to a separate PostgreSQL test database. '
        'Tests are blocked to prevent destructive resets against a live database.'
    )

os.environ['DATABASE_URL'] = test_database_url
os.environ['ENVIRONMENT'] = 'test'
os.environ['KIELTECH_TEST_MODE'] = '1'
os.environ['KIELTECH_ALLOW_DESTRUCTIVE_TEST_RESET'] = '1'